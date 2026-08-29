import type { Context } from 'grammy';
import type { InlineQueryResult } from 'grammy/types';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isApproved } from '../../db/repos/users.repo.js';
import { runAssistant } from '../../llm/assistant.js';
import { INLINE_QUERY_MARKER } from '../../llm/prompts.js';
import { scheduledMemory } from '../../scheduler.js';
import { makeRecallMemoryHandler } from '../flows/assist.js';
import { makeDotaLookupHandler } from '../../dota/lookup.js';
import { makeFlightStatusHandler } from '../../flight/handler.js';
import { makeSurfForecastHandler } from '../../surf/index.js';
import { makeSpendingReportHandler } from '../../spending/handler.js';
import { makeSummarizeChatHandler } from '../../summary/handler.js';
import {
  getChatMode,
  getPersonaPrompt,
  getTimezone,
} from '../../db/repos/chatSettings.repo.js';
import { listRules } from '../../db/repos/chatRule.repo.js';
import { botAdminLabels } from '../permissions.js';
import { recentTurns } from '../../db/repos/conversation.repo.js';
import { memorySubjects } from '../../db/repos/memoryItem.repo.js';
import { listEpisodes, recentEpisodes, episodeCount } from '../../db/repos/episode.repo.js';
import { listProfiles } from '../../db/repos/profile.repo.js';
import { renderEpisodeLine } from '../../episodes/render.js';
import { buildTopicIndex } from '../../util/topicIndex.js';
import { editInlineMarkdown } from '../../util/richMessage.js';

/**
 * INLINE mode: «@бот вопрос» typed in ANY chat answers the way the bot would
 * answer that user in their DM (their memory, mode, rules, journal — read-only).
 *
 * Telegram's inline machinery has three stones this file is built around:
 *
 * 1. `inline_query` fires on EVERY keystroke and must be answered within
 *    seconds — an LLM call from here would be slow AND fire per character. So
 *    the query handler never calls the LLM: it instantly serves one «спросить»
 *    card whose message is a placeholder, and the real work happens only after
 *    the user PICKS it (`chosen_inline_result` — exactly one event per send).
 * 2. `inline_message_id` (the only handle to edit the placeholder into the
 *    answer) is delivered ONLY when the sent message carries an inline
 *    keyboard — hence the stub «⏳» button on the placeholder, cleared by the
 *    final edit.
 * 3. Neither `chosen_inline_result` nor the button arrive unless the bot is set
 *    up in BotFather: /setinline (inline on) + /setinlinefeedback at 100%
 *    (without feedback the placeholder would hang forever) — see README.
 *
 * Access is default-deny like everything else, but STRICTER than the chat gate:
 * inline can be invoked by anyone from any chat and carries no chat id, so the
 * trusted-group exemption can't apply — only whitelisted (approved) users get
 * the card; everyone else gets a «закрыто» stub and never reaches the LLM.
 */

/** The card id (echoed back in chosen_inline_result.result_id). */
const INLINE_RESULT_ID = 'ask';

// Telegram caps a message at 4096 chars; leave headroom for the «❓ вопрос»
// header and HTML entity expansion in the fallback path.
const INLINE_ANSWER_MAX_CHARS = 3500;

/** Keep the question visible above the answer — it lands in a chat that never saw it. */
export function inlineMessageText(query: string, body: string): string {
  return `❓ ${query}\n\n${body}`;
}

export function inlinePlaceholder(query: string): string {
  return inlineMessageText(query, '⏳ Секретарь думает…');
}

/** Cut an overlong answer so the edited message never trips the 4096-char cap. */
export function clampInlineAnswer(text: string, max = INLINE_ANSWER_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…\n\n(ответ длинный — напиши мне в личку, там дорасскажу)`;
}

/**
 * One LLM run per user at a time: inline has no per-chat sequentialize lane
 * (there is no chat), and re-sending the card is one tap — without the guard a
 * user could fan out concurrent runs. The second pick gets told to wait.
 */
const inFlight = new Set<number>();

export async function onInlineQuery(ctx: Context): Promise<void> {
  const q = ctx.inlineQuery;
  if (!q) return;
  const cfg = loadConfig();

  // Flag off: answer with nothing so the client stops its spinner (the real
  // switch-off is disabling inline in BotFather, but the flag must not leave
  // queries hanging while that lags).
  if (!cfg.ENABLE_INLINE) {
    await answerSafe(ctx, [], { cache_time: 300, is_personal: true });
    return;
  }

  // Approved users only — inline reaches the bot from ANY chat, so there is no
  // trusted-group exemption here (see the auth note above). The stub button is
  // the one honest thing we can show a stranger; it opens the bot's DM where
  // /request works.
  if (!isApproved(q.from.id)) {
    await answerSafe(ctx, [], {
      cache_time: 60,
      is_personal: true,
      button: { text: 'Доступ закрыт — это приватный бот', start_parameter: 'inline-denied' },
    });
    return;
  }

  const query = q.query.trim();
  if (!query) {
    await answerSafe(ctx, [], {
      cache_time: 10,
      is_personal: true,
      button: { text: 'Напиши вопрос после имени бота', start_parameter: 'inline-help' },
    });
    return;
  }

  // No LLM here (stone #1) — one card, instantly. The stub keyboard is what
  // makes Telegram hand us inline_message_id later (stone #2); it links to the
  // bot's DM so even the placeholder button does something sensible.
  const results: InlineQueryResult[] = [
    {
      type: 'article',
      id: INLINE_RESULT_ID,
      title: 'Спросить секретаря',
      description: query,
      input_message_content: { message_text: inlinePlaceholder(query) },
      reply_markup: {
        inline_keyboard: [
          [{ text: '⏳ секретарь думает…', url: `https://t.me/${ctx.me.username}` }],
        ],
      },
    },
  ];
  await answerSafe(ctx, results, { cache_time: 0, is_personal: true });
}

export async function onChosenInlineResult(ctx: Context): Promise<void> {
  const chosen = ctx.chosenInlineResult;
  if (!chosen) return;
  const cfg = loadConfig();
  if (!cfg.ENABLE_INLINE) return;

  const uid = chosen.from.id;
  // Defence in depth: only our own card, only for a (still) approved user. The
  // card is served to approved users only, but approval can be revoked between
  // the keystroke and the pick.
  if (chosen.result_id !== INLINE_RESULT_ID || !isApproved(uid)) return;

  const query = chosen.query.trim();
  if (!query) return;

  const inlineMessageId = chosen.inline_message_id;
  if (!inlineMessageId) {
    // Without an id there is nothing to edit — the placeholder will hang. This
    // is a setup problem (stub keyboard missing, or Telegram not sending
    // feedback), so make it loud in the logs.
    logger.warn(
      { uid },
      'chosen_inline_result without inline_message_id — check /setinlinefeedback in BotFather',
    );
    return;
  }

  if (inFlight.has(uid)) {
    await editSafe(ctx, inlineMessageId, query, '⏳ Я ещё думаю над твоим прошлым вопросом — секунду, и спроси снова.');
    return;
  }
  inFlight.add(uid);
  try {
    const answer = await runInlineAnswer({
      tgUserId: uid,
      senderName: inlineSenderName(chosen.from),
      senderUsername: chosen.from.username ?? null,
      query,
    });
    await editInlineMarkdown(
      ctx.api,
      inlineMessageId,
      inlineMessageText(query, clampInlineAnswer(answer)),
    );
  } catch (err) {
    logger.error({ err, uid }, 'inline answer failed');
    await editSafe(ctx, inlineMessageId, query, '⚠️ Не получилось ответить — попробуй ещё раз чуть позже.');
  } finally {
    inFlight.delete(uid);
  }
}

function inlineSenderName(u: { first_name: string; last_name?: string; username?: string; id: number }): string {
  return (
    [u.first_name, u.last_name].filter(Boolean).join(' ') ||
    (u.username ? `@${u.username}` : `user ${u.id}`)
  );
}

/** answerInlineQuery is best-effort: a stale query_id (slow typer) is not an error. */
async function answerSafe(
  ctx: Context,
  results: InlineQueryResult[],
  other: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.answerInlineQuery(results, other);
  } catch (err) {
    logger.debug({ err }, 'answerInlineQuery failed (likely stale query)');
  }
}

async function editSafe(
  ctx: Context,
  inlineMessageId: string,
  query: string,
  body: string,
): Promise<void> {
  try {
    await ctx.api.editMessageTextInline(inlineMessageId, inlineMessageText(query, body));
  } catch (err) {
    logger.warn({ err }, 'inline edit failed');
  }
}

/**
 * Run the assistant for an inline question «так же, как ответил бы в личке»:
 * chatId = the asker's tg id (a private chat's id IS the user's id), so their DM
 * memory, mode/persona, rules, journal and recent DM history all apply.
 *
 * READ-ONLY by design, same flag set as a scheduled run: the answer is a
 * one-shot message posted into a chat the bot can't see, so it must not write
 * memory/rules/reminders/watches on the way (and there is no preview/confirm UI,
 * so record_expense is off via splidConnected: false — the prompt tells the
 * model to redirect expense asks to the DM). Read-only tools stay live: recall,
 * summarize, dota, surf, web search. Tone passes (humorizer/slang) are skipped —
 * this is an edited inline message, and the DM presets they'd apply to have them
 * off anyway. Nothing is written back to DM history either: the exchange
 * happened elsewhere, and phantom turns would confuse the next real DM talk.
 *
 * Exported for testing.
 */
export async function runInlineAnswer(args: {
  tgUserId: number;
  senderName: string;
  senderUsername: string | null;
  query: string;
}): Promise<string> {
  const cfg = loadConfig();
  const chatId = args.tgUserId;

  const mode = getChatMode(chatId);
  const personaPrompt = mode === 'custom' ? getPersonaPrompt(chatId) : null;

  const { memoryChat, memoryUsers, memoryPersona, memoryTotal } = scheduledMemory(
    chatId,
    args.tgUserId,
    cfg,
  );

  const journalOn = mode !== 'tutor' && cfg.ENABLE_EPISODES && cfg.ENABLE_CHAT_LOG;
  const journalTz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
  const journal = journalOn ? recentEpisodes(chatId, cfg.EPISODE_CONTEXT_COUNT) : [];
  const memoryTopics = buildTopicIndex({
    subjects: memorySubjects(chatId),
    episodeTopics: journalOn ? listEpisodes(chatId).map((e) => e.topics) : [],
    max: cfg.MEMORY_TOPIC_INDEX_MAX,
  });

  const result = await runAssistant(
    {
      mode,
      personaPrompt,
      defaultCurrency: cfg.DEFAULT_CURRENCY,
      members: [],
      memoryChat,
      memoryUsers,
      memoryPersona,
      memoryTotal,
      episodes: journal.map((e) => renderEpisodeLine(e, journalTz)),
      episodeTotal: journalOn ? episodeCount(chatId) : 0,
      memoryTopics,
      profiles:
        mode === 'tutor' || !cfg.ENABLE_PROFILES || !cfg.ENABLE_MEMORY
          ? []
          : listProfiles(chatId)
              .slice(0, cfg.PROFILE_CONTEXT_MAX)
              .map((p) => ({ subject: p.subject, content: p.content })),
      senderName: args.senderName,
      senderUsername: args.senderUsername,
      timezone: getTimezone(chatId),
      // No Splid in an inline answer even if the DM has a group: recording an
      // expense needs the preview/confirm keyboard, which inline can't host.
      splidConnected: false,
      // The DM's standing rules follow the user into inline — «отвечай короче»
      // must hold wherever the answer lands.
      rules: listRules(chatId).map((r) => r.text),
      botAdmins: botAdminLabels(chatId),
      // Write tools off (see the doc comment): an inline one-shot must not
      // change state, mirroring the scheduler's flag set.
      allowRemember: false,
      allowExpenseLearning: false,
      allowLexiconEdit: false,
      allowPingEdit: false,
      allowRules: false,
      allowReminders: false,
      allowWatch: false,
      allowFlightWatch: false,
      allowPoi: false,
      // The calendar stays OFF inline even though it is read-only: the answer is
      // posted into a chat the bot can't see, and the user's personal calendar
      // events must never land in a foreign chat via a quick inline ask.
      allowCalendar: false,
      // Recent DM history rides along so «а что я спрашивал вчера?» works the
      // same as it would in the DM itself.
      history: recentTurns(
        chatId,
        cfg.CONVERSATION_HISTORY_LIMIT,
        cfg.CONVERSATION_HISTORY_MAX_AGE_HOURS * 60 * 60 * 1000,
      ),
      userContent: `${INLINE_QUERY_MARKER}\n${args.query}`,
    },
    {
      remember: () => 'noop',
      editMemory: () => 'noop',
      recallMemory: makeRecallMemoryHandler(chatId),
      learnExpense: () => 'noop',
      editLexicon: () => 'noop',
      editPingList: () => 'noop',
      setRule: () => 'noop',
      scheduleTask: () => 'noop',
      watchPage: () => 'noop',
      // Read-only, so it stays live inline — «@бот статус K6829» just answers.
      flightStatus: makeFlightStatusHandler(),
      watchFlight: () => 'noop',
      dotaLookup: makeDotaLookupHandler(),
      surfForecast: makeSurfForecastHandler(),
      addPoi: () => 'noop',
      spendingReport: makeSpendingReportHandler(chatId),
      summarizeChat: makeSummarizeChatHandler(chatId),
      // Never exposed inline (allowCalendar: false above) — noop belt-and-braces.
      calendarEvents: () => 'noop',
    },
  );

  // record_expense is off (splidConnected: false), so an expense result can't
  // happen — but never trust that with a crash: degrade to a redirect line.
  if (result.kind !== 'text') {
    return 'Трату через инлайн не оформить — напиши мне в личку или в чат, где я подключён.';
  }
  return result.text;
}
