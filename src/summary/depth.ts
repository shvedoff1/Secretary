// How deep the chat's raw message log goes, rendered for the context block.
//
// The model's own view of a chat is tiny: a couple of dozen verbatim turns, plus
// the journal once sessions start closing. Nothing told it that `chat_message_log`
// exists — so «восстанови картину по истории чата» came back as «доступ есть
// только к тексту сообщений», which was an honest description of what it could
// see and a wrong answer about what it could reach. This one line closes that gap.

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { countLog, oldestLoggedAt } from '../db/repos/chatLog.repo.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import { zonedParts } from '../util/day.js';
import { humanDay } from './transcript.js';

export interface ChatLogDepth {
  total: number;
  /** Oldest kept day, as a chat-local human date («1 августа»), or null. */
  oldest: string | null;
}

/**
 * Depth of a chat's log, or null when there is nothing to point at (logging off,
 * empty log). Best-effort: a failed read must never cost a reply, so it degrades
 * to null — the block then simply omits the line, exactly as before.
 */
export function chatLogDepth(chatId: number): ChatLogDepth | null {
  const cfg = loadConfig();
  if (!cfg.ENABLE_CHAT_LOG) return null;
  try {
    const total = countLog(chatId);
    if (total <= 0) return null;
    const oldestMs = oldestLoggedAt(chatId);
    const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
    return {
      total,
      oldest: oldestMs === null ? null : humanDay(zonedParts(oldestMs, tz).dateStr, tz),
    };
  } catch (err) {
    logger.warn({ err, chatId }, 'chat log depth read failed');
    return null;
  }
}
