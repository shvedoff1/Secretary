import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import { countLog, oldestLoggedAt, readLog } from '../db/repos/chatLog.repo.js';
import { condenseChunks } from '../llm/summarize.js';
import type { SummarizeChatInput } from '../llm/schema.js';
import { humanDay, planCondense, renderTranscript, resolveSummaryWindow } from './transcript.js';
import { zonedParts } from '../util/day.js';

const HEADER =
  'CHAT TRANSCRIPT (oldest first). Each line: [local time] Author: text; «Бот» is you, «(голосовое)» is a voice transcript, «(фото)» a photo caption.';
const TASK =
  'Summarise this for the user in their language and your usual voice: what was discussed, decisions/plans/agreements, open questions, and who was involved. Do NOT invent anything that is not in the transcript.';

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

    let messages;
    try {
      messages = readLog(chatId, {
        limit: window.limit,
        fromMs: window.fromMs,
        toMs: window.toMs,
      });
    } catch (err) {
      logger.error({ err, chatId }, 'summarize_chat log read failed');
      return 'Could not read the chat log. Tell the user the log is unavailable right now.';
    }

    if (messages.length === 0) {
      const total = countLog(chatId);
      const oldest = oldestLoggedAt(chatId);
      // An empty window is not the same as an empty log — say which, so the model
      // answers «за вчера тут тишина» instead of «я ничего не помню».
      if (total === 0) {
        return 'The chat log is EMPTY — nothing has been logged for this chat yet (logging starts from the moment the feature was switched on). Tell the user you have nothing recorded yet.';
      }
      return `No messages in the requested window (${window.label}). The log holds ${total} message(s) for this chat, the oldest from ${humanDay(zonedParts(oldest ?? now, tz).dateStr, tz)}. Tell the user that period is empty, and offer the period you do have.`;
    }

    const inWindow = countLog(chatId, { fromMs: window.fromMs, toMs: window.toMs });
    const verbatim = renderTranscript(messages, { tz, charBudget: cfg.SUMMARY_CHAR_BUDGET });

    // Everything fits as-is — the cheap tier would only lose detail here.
    if (verbatim.dropped === 0) {
      const notes = [
        `Window: ${window.label}. Rendered ${verbatim.used} message(s) of ${inWindow} logged in that window; timezone ${tz}.`,
      ];
      if (inWindow > verbatim.used) {
        notes.push(
          `The window holds ${inWindow - verbatim.used} older message(s) beyond the requested count — call the tool again with a bigger limit if the user wants them.`,
        );
      }
      logger.info(
        { chatId, requested: window.limit, rendered: verbatim.used, mode: 'verbatim' },
        'summarize_chat window',
      );
      return [HEADER, notes.join(' '), '', verbatim.text, '', TASK].join('\n');
    }

    // Too big to pass verbatim. Without the condense pass all we can do is cut.
    if (!cfg.ENABLE_SUMMARY_CONDENSE) {
      logger.info(
        { chatId, rendered: verbatim.used, dropped: verbatim.dropped, mode: 'truncated' },
        'summarize_chat window',
      );
      return [
        HEADER,
        `Window: ${window.label}. Rendered ${verbatim.used} message(s) of ${inWindow} logged in that window; timezone ${tz}. The ${verbatim.dropped} OLDEST message(s) did not fit the size budget and are not shown — say the recap covers only the tail.`,
        '',
        verbatim.text,
        '',
        TASK,
      ].join('\n');
    }

    const plan = planCondense(messages, {
      tz,
      tailChars: cfg.SUMMARY_TAIL_CHAR_BUDGET,
      chunkChars: cfg.SUMMARY_CONDENSE_CHUNK_CHARS,
      maxChunks: cfg.SUMMARY_CONDENSE_MAX_CHUNKS,
    });
    const { notes, failed } = await condenseChunks(plan.chunks);
    logger.info(
      {
        chatId,
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
        `Window: ${window.label}. Compressing the older part of this window FAILED, so only the most recent ${verbatim.used} of ${inWindow} message(s) are shown; timezone ${tz}. Say the recap covers only the recent part.`,
        '',
        verbatim.text,
        '',
        TASK,
      ].join('\n');
    }

    const meta = [
      `Window: ${window.label}. ${plan.condensedCount + plan.tailCount} message(s) of ${inWindow} logged in that window; timezone ${tz}.`,
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
      TASK,
    ].join('\n');
  };
}
