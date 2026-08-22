// Thin recording layer over the raw chat log (chat_message_log).
//
// Every message the bot SEES goes through here — including the group chatter it
// never answers, which is the whole point: the assistant's own history window
// (conversation_turn) holds only turns the bot took part in, so «перескажи, что
// тут было» had nothing to read. The log is what `summarize_chat` reads back.
//
// Best-effort by design: a failed write must never break a reply, so everything is
// wrapped and only logged as a warning.

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { logMessage, pruneLog, type LogKind, type LogRole } from '../db/repos/chatLog.repo.js';

/** How many inserts to let through before trimming a chat's log again. */
const PRUNE_EVERY = 50;
const sincePrune = new Map<number, number>();

export function isChatLogEnabled(): boolean {
  return loadConfig().ENABLE_CHAT_LOG;
}

/**
 * Record one line of a chat. `forwarded` tags the content the same way history
 * turns are tagged, so a recap doesn't read someone else's forwarded words as
 * something the sender said.
 */
export function recordChatLog(args: {
  chatId: number;
  role: LogRole;
  kind?: LogKind;
  tgUserId: number | null;
  senderName?: string | null;
  content: string;
  forwarded?: boolean;
}): void {
  if (!isChatLogEnabled()) return;
  const cfg = loadConfig();
  try {
    logMessage({
      chatId: args.chatId,
      role: args.role,
      kind: args.kind ?? 'text',
      tgUserId: args.tgUserId,
      senderName: args.senderName ?? null,
      content: args.forwarded ? `[переслано] ${args.content}` : args.content,
    });
    // Trimming on every insert would double the writes on a busy chat for no gain
    // — the bounds are generous, so amortise it.
    const n = (sincePrune.get(args.chatId) ?? 0) + 1;
    if (n >= PRUNE_EVERY) {
      sincePrune.set(args.chatId, 0);
      pruneLog(
        args.chatId,
        cfg.CHAT_LOG_KEEP_PER_CHAT,
        cfg.CHAT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
    } else {
      sincePrune.set(args.chatId, n);
    }
  } catch (err) {
    logger.warn({ err, chatId: args.chatId }, 'chat log write failed');
  }
}

/** Test helper: forget the per-chat prune counters. */
export function resetChatLogCounters(): void {
  sincePrune.clear();
}
