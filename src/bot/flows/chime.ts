import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { runAndRespond } from './assist.js';

/**
 * Spontaneous "chime-in": every so often the bot jumps into group chatter it was
 * NOT addressed in and keeps the conversation going by context — as if it had been
 * pinged. The catch is timing: replying the instant a message lands would (a) make
 * the bot talk over an active back-and-forth and (b) burn an LLM call on a thread
 * that's still moving. So instead of replying immediately we ARM a chime on a
 * winning roll and wait for a lull — `CHIME_QUIET_SECONDS` of silence after the
 * message we rolled on. Any new message in that window cancels the pending chime
 * (the chat is clearly still active), so the reply only ever lands once things have
 * gone quiet. At that point we feed the recent messages to the assistant and let it
 * continue the conversation naturally.
 *
 * State is in-memory and per chat — a rolling buffer of recent message lines plus
 * the single pending timer. There is at most one armed chime per chat at a time.
 */
interface ChimeState {
  timer: ReturnType<typeof setTimeout> | null;
  recent: { name: string; text: string }[];
}

// How many recent lines of chatter to keep per chat as context for a chime.
const RECENT_MAX = 12;

const states = new Map<number, ChimeState>();

function getState(chatId: number): ChimeState {
  let s = states.get(chatId);
  if (!s) {
    s = { timer: null, recent: [] };
    states.set(chatId, s);
  }
  return s;
}

/**
 * Record a chat message into the rolling context buffer (newest last, capped at
 * `RECENT_MAX`). Called for every text message so a chime — whenever it fires — has
 * the latest chatter to continue from. Does NOT touch the timer.
 */
export function recordChatMessage(chatId: number, name: string, text: string): void {
  const s = getState(chatId);
  s.recent.push({ name, text });
  if (s.recent.length > RECENT_MAX) s.recent.splice(0, s.recent.length - RECENT_MAX);
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

/**
 * With `CHIME_PROBABILITY`, arm a delayed chime for an otherwise-ignored group
 * message. The reply doesn't go out now — it's scheduled for after a lull and is
 * cancelled by {@link cancelChime} if anyone speaks again first. Best-effort: a
 * failed assistant call is logged, never thrown (it runs detached on a timer).
 */
export function maybeScheduleChime(ctx: Context): void {
  const cfg = loadConfig();
  if (!cfg.ENABLE_CHIME) return;
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  if (Math.random() >= cfg.CHIME_PROBABILITY) return;

  const s = getState(chatId);
  // A new message arrived since any prior arm; clear it and re-arm on this one so
  // the wait always measures silence from the most recent message.
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void fireChime(ctx, chatId).catch((err) => logger.warn({ err }, 'chime failed'));
  }, cfg.CHIME_QUIET_SECONDS * 1000);
  // Don't keep the process alive just for a pending chime.
  s.timer.unref?.();
}

/**
 * Actually produce the spontaneous reply: hand the recent chatter to the assistant
 * as if the bot had been pinged, and let it continue by context. Runs the normal
 * addressed path so the message is sent (and recorded into conversation history).
 */
async function fireChime(ctx: Context, chatId: number): Promise<void> {
  const recent = states.get(chatId)?.recent ?? [];
  if (recent.length === 0) return;

  const lines = recent.map((r) => `${r.name}: ${r.text}`).join('\n');
  const last = recent[recent.length - 1]!;
  const userContent =
    '[Системная пометка: тебя никто не звал напрямую. В чате повисла пауза после ' +
    'недавней болтовни, и ты решил по-дружески вклиниться, как будто тебя пингнули. ' +
    'Продолжи разговор коротко и естественно ПО КОНТЕКСТУ последних сообщений ниже. ' +
    'Не упоминай эту пометку и не используй инструменты без необходимости.\n\n' +
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

/** Test helper: drop all in-memory chime state. */
export function clearChimeState(): void {
  for (const s of states.values()) {
    if (s.timer) clearTimeout(s.timer);
  }
  states.clear();
}
