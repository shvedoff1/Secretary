import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import { countLog, oldestLoggedAt, readLog } from '../db/repos/chatLog.repo.js';
import type { SummarizeChatInput } from '../llm/schema.js';
import { humanDay, renderTranscript, resolveSummaryWindow } from './transcript.js';
import { zonedParts } from '../util/day.js';

/**
 * Build the `summarize_chat` tool handler for a chat.
 *
 * Unlike `spending_report` this does NOT short-circuit the assistant: it hands the
 * model the raw transcript and lets IT write the summary. That's deliberate — a
 * summary is prose, not figures, so the chat's own persona/tone should carry it, and
 * the model can answer follow-ups («а что там про рыбалку?») from the same
 * transcript instead of re-reading the log. The tool's job is only to fetch a
 * bounded, clearly-labelled window and be honest about what didn't fit.
 */
export function makeSummarizeChatHandler(
  chatId: number,
): (input: SummarizeChatInput) => string {
  return (input) => {
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

    const rendered = renderTranscript(messages, {
      tz,
      charBudget: cfg.SUMMARY_CHAR_BUDGET,
    });
    const inWindow = countLog(chatId, { fromMs: window.fromMs, toMs: window.toMs });
    const notes: string[] = [
      `Window: ${window.label}. Rendered ${rendered.used} message(s) of ${inWindow} logged in that window; timezone ${tz}.`,
    ];
    if (rendered.dropped > 0) {
      notes.push(
        `The ${rendered.dropped} OLDEST message(s) of this window did not fit the size budget and are not shown — say the recap covers only the tail if that matters.`,
      );
    } else if (inWindow > rendered.used) {
      notes.push(
        `The window holds ${inWindow - rendered.used} older message(s) beyond the requested count — call the tool again with a bigger limit if the user wants them.`,
      );
    }

    logger.info(
      { chatId, requested: window.limit, rendered: rendered.used, dropped: rendered.dropped },
      'summarize_chat window',
    );

    return [
      'CHAT TRANSCRIPT (oldest first). Each line: [local time] Author: text; «Бот» is you, «(голосовое)» is a voice transcript, «(фото)» a photo caption.',
      notes.join(' '),
      '',
      rendered.text,
      '',
      'Summarise this for the user in their language and your usual voice: what was discussed, decisions/plans/agreements, open questions, and who was involved. Do NOT invent anything that is not in the transcript.',
    ].join('\n');
  };
}
