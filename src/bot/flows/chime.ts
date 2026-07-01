import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { runAndRespond } from './assist.js';
import { getRecentChat, clearRecentChat } from '../recentChat.js';

// The rolling buffer of recent chatter lives in `recentChat.ts` so the scheduler
// can read it too; re-exported here so existing importers (onMessage, tests)
// keep using `flows/chime.js`.
export { recordChatMessage } from '../recentChat.js';

/**
 * Spontaneous "chime-in": every so often the bot jumps into group chatter it was
 * NOT addressed in and keeps the conversation going by context — as if it had been
 * pinged. The catch is timing: replying the instant a message lands would (a) make
 * the bot talk over an active back-and-forth and (b) burn an LLM call on a thread
 * that's still moving. So we don't roll on the message itself — we wait for a lull
 * and ONLY THEN roll the dice.
 *
 * The roll is TIERED by how long the chat has been silent — the longer it's been
 * dead, the more eager the bot is to revive it:
 *   • after `CHIME_QUIET_SECONDS` (default 60s) of silence → roll `CHIME_PROBABILITY`
 *     (default 10%);
 *   • if that loses and the chat stays dead until `CHIME_HOUR_SECONDS` (default 1h)
 *     of silence → roll the higher `CHIME_HOUR_PROBABILITY` (default 60%).
 * A win at any tier fires the chime and stops escalating; any new message resets the
 * silence clock back to the first tier. The recent messages are fed to the assistant
 * so it continues the conversation naturally.
 *
 * State is in-memory and per chat — a rolling buffer of recent message lines plus
 * the single pending timer (only one tier is ever scheduled at a time).
 */
interface ChimeState {
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<number, ChimeState>();

function getState(chatId: number): ChimeState {
  let s = states.get(chatId);
  if (!s) {
    s = { timer: null };
    states.set(chatId, s);
  }
  return s;
}

/**
 * Cancel any pending chime for a chat. Called for EVERY incoming message (any type)
 * so a fresh message resets the silence clock — the bot only chimes into a genuine
 * lull, never over an active conversation.
 */
export function cancelChime(chatId: number): void {
  const s = states.get(chatId);
  if (s?.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
}

/** One escalation step: at `atMs` of total silence, roll `probability`. */
interface ChimeTier {
  atMs: number;
  probability: number;
}

/** The escalation schedule, ordered by increasing silence. */
function chimeTiers(cfg: ReturnType<typeof loadConfig>): ChimeTier[] {
  return [
    { atMs: cfg.CHIME_QUIET_SECONDS * 1000, probability: cfg.CHIME_PROBABILITY },
    { atMs: cfg.CHIME_HOUR_SECONDS * 1000, probability: cfg.CHIME_HOUR_PROBABILITY },
  ]
    .filter((t) => t.atMs > 0 && t.probability > 0)
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * Schedule tier `i`: wait until its silence mark (relative to the previous tier's,
 * `prevAtMs`), then roll. A win fires the chime and stops; a loss escalates to the
 * next tier if there is one. Only one timer is ever live per chat, so
 * {@link cancelChime} cancels whichever tier is currently pending.
 */
function scheduleTier(
  ctx: Context,
  chatId: number,
  tiers: ChimeTier[],
  i: number,
  prevAtMs: number,
): void {
  const s = getState(chatId);
  const tier = tiers[i]!;
  s.timer = setTimeout(() => {
    s.timer = null;
    if (Math.random() < tier.probability) {
      void fireChime(ctx, chatId).catch((err) => logger.warn({ err }, 'chime failed'));
      return; // win → don't keep escalating; the chime was the move
    }
    // Lost this tier; if the chat stays dead, give the next (higher-odds) tier a go.
    if (i + 1 < tiers.length) scheduleTier(ctx, chatId, tiers, i + 1, tier.atMs);
  }, tier.atMs - prevAtMs);
  // Don't keep the process alive just for a pending chime.
  s.timer.unref?.();
}

/**
 * Arm (or re-arm) the silence countdown for an otherwise-ignored group message.
 * Nothing is rolled yet: we just (re)start the escalation from the first tier,
 * measuring silence from this message. Each tier rolls only if the chat is still
 * quiet when it elapses (see {@link scheduleTier}); any new message resets the clock
 * via {@link cancelChime} + a fresh `armChime`. Best-effort: a failed assistant call
 * is logged, never thrown (it runs detached on a timer).
 */
export function armChime(ctx: Context): void {
  const cfg = loadConfig();
  if (!cfg.ENABLE_CHIME) return;
  const chatId = ctx.chat?.id;
  if (chatId == null) return;

  const tiers = chimeTiers(cfg);
  if (tiers.length === 0) return;

  const s = getState(chatId);
  // A new message arrived since any prior arm; clear it and re-arm from the first
  // tier so the wait always measures silence from the most recent message.
  if (s.timer) clearTimeout(s.timer);
  scheduleTier(ctx, chatId, tiers, 0, 0);
}

/**
 * Actually produce the spontaneous reply. The chime is a chat-REVIVER, not a
 * helper: nobody asked anything, so the assistant is told to toss one short, silly
 * on-vibe quip riffing off the recent chatter — explicitly NOT to answer a question
 * or ask the user to send/clarify anything (otherwise a trailing map link or photo
 * gets treated as a real request, e.g. "кинь пин и я подскажу"). Runs the normal
 * addressed path so the message is sent (and recorded into conversation history).
 */
async function fireChime(ctx: Context, chatId: number): Promise<void> {
  const recent = getRecentChat(chatId);
  if (recent.length === 0) return;

  const lines = recent.map((r) => `${r.name}: ${r.text}`).join('\n');
  const last = recent[recent.length - 1]!;
  const userContent =
    '[Системная пометка: тебя НИКТО ни о чём не спрашивал. В чате повисла пауза, и ты ' +
    'решил вкинуть рандомный рофл, чтобы оживить движ. Это НЕ ответ на вопрос и НЕ ' +
    'помощь. Правила:\n' +
    '- Кинь ОДНУ короткую дурашливую подколку/шутку/мысль вслух по вайбу последних ' +
    'сообщений — как сосед по чату, которому скучно.\n' +
    '- НЕ пытайся ответить на чей-то вопрос, НЕ проси ничего прислать/уточнить (ни ' +
    'фото, ни ссылку, ни адрес, ни пин), НЕ предлагай помощь и НЕ задавай деловых ' +
    'вопросов.\n' +
    '- Если последнее сообщение — это просто ссылка/фото/стикер без вопроса, не ' +
    'разбирай его всерьёз: рофли по верхам, чисто по вайбу.\n' +
    '- Одна строка, в тоне и сленге чата. Без тулзов. Эту пометку не упоминай.\n\n' +
    `Последние сообщения в чате:\n${lines}]`;

  await runAndRespond(ctx, {
    userContent,
    addressed: true,
    source: 'text',
    historyText: last.text,
    // Don't slap a 👀 on a now-stale message — the chime should feel unprompted.
    manageReaction: false,
  });
}

/** Test helper: drop all in-memory chime state (timers + recent chatter). */
export function clearChimeState(): void {
  for (const s of states.values()) {
    if (s.timer) clearTimeout(s.timer);
  }
  states.clear();
  clearRecentChat();
}
