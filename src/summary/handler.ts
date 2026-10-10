import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import { countLog, listLoggedChats, oldestLoggedAt, readLog } from '../db/repos/chatLog.repo.js';
import { condenseChunks } from '../llm/summarize.js';
import type { SummarizeChatInput } from '../llm/schema.js';
import {
  humanDay,
  planCondense,
  renderTranscript,
  resolveSummaryWindow,
  resolveChatRef,
  resolveThread,
  type LineOptions,
} from './transcript.js';
import type { ChatReadCheck } from './access.js';
import { listTopics } from '../db/repos/topic.repo.js';
import { zonedParts } from '../util/day.js';

const HEADER =
  'CHAT TRANSCRIPT (oldest first). Each line: [local time] {topic, in forum chats} Author: text; «Бот» is you, «(голосовое)» is a voice transcript, «(фото)»/«(видео)»/«(файл)» a media message (its caption, if any). «[медиа #N]» marks a picture or video still you have NOT seen — open one with view_media only if the answer depends on what is in it. A trailing https://t.me/c/… is the link to that message — use it to cite sources.';
const TASK =
  'Summarise this for the user in their language and your usual voice: what was discussed, decisions/plans/agreements, open questions, and who was involved. Do NOT invent anything that is not in the transcript.';

/** The closing instruction when the user asked for something narrower than a recap. */
function focusedTask(focus: string): string {
  return `The user is looking specifically for: «${focus}». Answer THAT from the transcript, not a general recap: list every matching item (merge duplicates — the same issue described twice is one item), each with who raised it, when, and the source link when the line has one. Mark items that are only a guess as such. Do NOT invent details (steps, versions, screens) that are not in the transcript. If nothing matches, say so plainly.`;
}

/**
 * Build the `summarize_chat` tool handler for a chat.
 *
 * Unlike `spending_report` this does NOT short-circuit the assistant: it hands the
 * model the transcript and lets IT write the summary. That's deliberate — a summary
 * is prose, not figures, so the chat's own persona should carry it, and the model
 * can answer follow-ups («а что там про рыбалку?») from the same window instead of
 * re-reading the log.
 *
 * TWO TIERS by size. A window that fits `SUMMARY_CHAR_BUDGET` goes over verbatim.
 * A bigger one («перескажи последние 500 сообщений» — several times the budget)
 * would otherwise lose most of its span to truncation, so the OLDER part is first
 * compressed by a cheap model (`src/llm/summarize.ts`, in parallel chunks) and only
 * the newest slice stays word-for-word. The tool always states which parts are
 * notes, which are verbatim, and what didn't fit at all.
 */
export function makeSummarizeChatHandler(
  chatId: number,
  opts: {
    /** Forum topic the asking message came from («что было в этом треде»). */
    currentThreadId?: number | null;
    /**
     * Reading ANOTHER chat's log by `input.chat` — DM only (an answer about a work
     * chat must never land in a third chat) and only for a current MEMBER of that
     * chat (see summary/access.ts). Absent => `chat` is refused.
     */
    crossChat?: { canRead: ChatReadCheck };
  } = {},
): (input: SummarizeChatInput) => Promise<string> {
  return async (input) => {
    const cfg = loadConfig();
    if (!cfg.ENABLE_CHAT_LOG) {
      return 'Chat logging is disabled (ENABLE_CHAT_LOG=false) — there is no message log to summarise. Tell the user you do not keep a log of this chat.';
    }
    const tz = getTimezone(chatId) ?? input.timezone ?? cfg.DEFAULT_TIMEZONE;
    const now = Date.now();
    const window = resolveSummaryWindow(input, tz, now, {
      defaultLimit: cfg.SUMMARY_DEFAULT_MESSAGES,
      maxLimit: cfg.SUMMARY_MAX_MESSAGES,
    });

    // Which chat's log: this one, or — from the DM — the work chat the user named.
    let target = chatId;
    let currentThreadId = opts.currentThreadId ?? null;
    let chatNote = '';
    if (input.chat?.trim()) {
      if (!opts.crossChat) {
        return 'Reading ANOTHER chat is only possible from a private chat with the bot (an answer about one chat must not be posted into a different one). Here you can only recap THIS chat — call again with chat=null, or tell the user to ask in the DM.';
      }
      const resolved = resolveChatRef(input.chat, listLoggedChats());
      if (!resolved.ok) return resolved.error;
      if (resolved.chatId !== chatId) {
        if (!(await opts.crossChat.canRead(resolved.chatId))) {
          logger.info({ chatId, target: resolved.chatId }, 'summarize_chat cross-chat read denied');
          return `The user is not a member of «${resolved.label}» (or the bot can't check), so you may NOT read or describe that chat. Tell them plainly you only answer about chats they are in.`;
        }
        target = resolved.chatId;
        currentThreadId = null; // «этот тред» means nothing from the DM
        chatNote = ` Chat: «${resolved.label}» (read from the DM — the user is a member).`;
      }
    }
    const topics = listTopics(target);
    const thread = resolveThread(input.thread, topics, currentThreadId);
    if (!thread.ok) return thread.error;
    const kinds = input.kinds?.length ? input.kinds : null;
    const filter = {
      fromMs: window.fromMs,
      toMs: window.toMs,
      threadId: thread.threadId,
      kinds,
    };
    const scope = [
      thread.label ? `topic «${thread.label}»` : null,
      kinds ? `only ${kinds.join('/')} messages` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const scopeNote = `${chatNote}${scope ? ` Scope: ${scope}.` : ''}`;
    const focus = input.focus?.trim() || null;
    const task = focus ? focusedTask(focus) : TASK;

    let messages;
    try {
      messages = readLog(target, { limit: window.limit, ...filter });
    } catch (err) {
      logger.error({ err, chatId: target }, 'summarize_chat log read failed');
      return 'Could not read the chat log. Tell the user the log is unavailable right now.';
    }

    if (messages.length === 0) {
      const total = countLog(target);
      const oldest = oldestLoggedAt(target);
      // An empty window is not the same as an empty log — say which, so the model
      // answers «за вчера тут тишина» instead of «я ничего не помню».
      if (total === 0) {
        return 'The chat log is EMPTY — nothing has been logged for this chat yet (logging starts from the moment the feature was switched on). Tell the user you have nothing recorded yet.';
      }
      if (scope && countLog(target, { fromMs: window.fromMs, toMs: window.toMs }) > 0) {
        return `No messages in the requested window (${window.label}) match the scope (${scope}), though the window itself has other messages. Tell the user exactly that — and offer to look wider.`;
      }
      return `No messages in the requested window (${window.label}). The log holds ${total} message(s) for this chat, the oldest from ${humanDay(zonedParts(oldest ?? now, tz).dateStr, tz)}. Tell the user that period is empty, and offer the period you do have.`;
    }

    const inWindow = countLog(target, filter);
    // Topic tags only when the window actually spans several topics (in a single
    // thread, or a chat without forums, they'd be noise on every line).
    const spansTopics =
      thread.threadId === null && new Set(messages.map((m) => m.threadId ?? 0)).size > 1;
    const lineOpts: LineOptions = {
      tz,
      chatId: target,
      topicNames: spansTopics ? new Map(topics.map((t) => [t.threadId, t.name])) : null,
      // A focused ask (bug candidates) cites any line; a plain recap only the
      // voice/media lines a reader can't skim in the chat.
      links: focus ? 'all' : 'media',
    };
    const verbatim = renderTranscript(messages, { ...lineOpts, charBudget: cfg.SUMMARY_CHAR_BUDGET });

    // Everything fits as-is — the cheap tier would only lose detail here.
    if (verbatim.dropped === 0) {
      const notes = [
        `Window: ${window.label}.${scopeNote} Rendered ${verbatim.used} message(s) of ${inWindow} logged in that window; timezone ${tz}.`,
      ];
      if (inWindow > verbatim.used) {
        notes.push(
          `The window holds ${inWindow - verbatim.used} older message(s) beyond the requested count — call the tool again with a bigger limit if the user wants them.`,
        );
      }
      logger.info(
        { chatId: target, requested: window.limit, rendered: verbatim.used, mode: 'verbatim' },
        'summarize_chat window',
      );
      return [HEADER, notes.join(' '), '', verbatim.text, '', task].join('\n');
    }

    // Too big to pass verbatim. Without the condense pass all we can do is cut.
    if (!cfg.ENABLE_SUMMARY_CONDENSE) {
      logger.info(
        { chatId: target, rendered: verbatim.used, dropped: verbatim.dropped, mode: 'truncated' },
        'summarize_chat window',
      );
      return [
        HEADER,
        `Window: ${window.label}.${scopeNote} Rendered ${verbatim.used} message(s) of ${inWindow} logged in that window; timezone ${tz}. The ${verbatim.dropped} OLDEST message(s) did not fit the size budget and are not shown — say the recap covers only the tail.`,
        '',
        verbatim.text,
        '',
        task,
      ].join('\n');
    }

    const plan = planCondense(messages, {
      ...lineOpts,
      tailChars: cfg.SUMMARY_TAIL_CHAR_BUDGET,
      chunkChars: cfg.SUMMARY_CONDENSE_CHUNK_CHARS,
      maxChunks: cfg.SUMMARY_CONDENSE_MAX_CHUNKS,
    });
    const { notes, failed } = await condenseChunks(plan.chunks, focus);
    logger.info(
      {
        chatId: target,
        requested: window.limit,
        condensed: plan.condensedCount,
        verbatimTail: plan.tailCount,
        chunks: plan.chunks.length,
        failed,
        dropped: plan.dropped,
        mode: 'condensed',
      },
      'summarize_chat window',
    );

    // Every chunk failed → the compressed half is simply missing, so fall back to
    // the truncated verbatim window rather than recapping from the tail alone while
    // claiming to cover the whole period.
    if (notes.length === 0) {
      return [
        HEADER,
        `Window: ${window.label}.${scopeNote} Compressing the older part of this window FAILED, so only the most recent ${verbatim.used} of ${inWindow} message(s) are shown; timezone ${tz}. Say the recap covers only the recent part.`,
        '',
        verbatim.text,
        '',
        task,
      ].join('\n');
    }

    const meta = [
      `Window: ${window.label}.${scopeNote} ${plan.condensedCount + plan.tailCount} message(s) of ${inWindow} logged in that window; timezone ${tz}.`,
      `The window was too long to show word-for-word, so the OLDER ${plan.condensedCount} message(s) appear as CONDENSED NOTES (facts kept, wording dropped) and the newest ${plan.tailCount} follow VERBATIM.`,
    ];
    if (failed > 0) {
      meta.push(
        `${failed} block(s) of the older part could not be compressed and are missing entirely — mention that the recap has a gap in the earlier stretch.`,
      );
    }
    if (plan.dropped > 0) {
      meta.push(
        `${plan.dropped} even older message(s) of the window were left out completely — say the recap starts partway into the period.`,
      );
    }

    return [
      HEADER,
      meta.join(' '),
      '',
      '=== CONDENSED NOTES (older part, oldest first) ===',
      notes.join('\n'),
      '',
      `=== VERBATIM (newest ${plan.tailCount} message(s)) ===`,
      plan.tail,
      '',
      task,
    ].join('\n');
  };
}
