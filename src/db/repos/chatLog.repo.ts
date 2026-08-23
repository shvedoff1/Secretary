import { getDb } from '../client.js';

export type LogRole = 'user' | 'assistant';
/** Channel the line came through — a voice note reads differently from a caption. */
export type LogKind = 'text' | 'voice' | 'photo' | 'file';

export interface LoggedMessage {
  id: number;
  role: LogRole;
  kind: LogKind;
  tgUserId: number | null;
  /** Author's display name; null for the bot's own posts. */
  senderName: string | null;
  content: string;
  createdAt: number;
}

/**
 * Append one line to the chat's raw log. Called for EVERY message the bot sees —
 * including the ones it never answers — which is what makes «перескажи, что тут
 * было» possible at all (see the migration for why conversation_turn can't).
 */
export function logMessage(args: {
  chatId: number;
  role: LogRole;
  kind?: LogKind;
  tgUserId: number | null;
  senderName?: string | null;
  content: string;
  /** Test seam: explicit timestamp. Defaults to now. */
  createdAt?: number;
}): void {
  const text = args.content.trim();
  if (!text) return;
  getDb()
    .prepare(
      `INSERT INTO chat_message_log (chat_id, tg_user_id, sender_name, role, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.chatId,
      args.tgUserId,
      args.senderName ?? null,
      args.role,
      args.kind ?? 'text',
      text,
      args.createdAt ?? Date.now(),
    );
}

/**
 * Read a window of the log back, oldest first — the shape a transcript is rendered
 * from. `limit` counts from the NEWEST end (the last N messages), so a window is
 * always "the most recent N of the range", never the first N of it.
 */
export function readLog(
  chatId: number,
  opts: { limit: number; fromMs?: number | null; toMs?: number | null },
): LoggedMessage[] {
  const from = opts.fromMs ?? null;
  const to = opts.toMs ?? null;
  const rows = getDb()
    .prepare(
      `SELECT id, role, kind, tg_user_id, sender_name, content, created_at
       FROM chat_message_log
       WHERE chat_id = ?
         AND (? IS NULL OR created_at >= ?)
         AND (? IS NULL OR created_at <= ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(chatId, from, from, to, to, opts.limit) as {
    id: number;
    role: LogRole;
    kind: LogKind;
    tg_user_id: number | null;
    sender_name: string | null;
    content: string;
    created_at: number;
  }[];
  return rows
    .map((r) => ({
      id: r.id,
      role: r.role,
      kind: r.kind,
      tgUserId: r.tg_user_id,
      senderName: r.sender_name,
      content: r.content,
      createdAt: r.created_at,
    }))
    .reverse();
}

/** How many lines the log holds for a chat (optionally within a window). */
export function countLog(
  chatId: number,
  opts: { fromMs?: number | null; toMs?: number | null } = {},
): number {
  const from = opts.fromMs ?? null;
  const to = opts.toMs ?? null;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
       FROM chat_message_log
       WHERE chat_id = ?
         AND (? IS NULL OR created_at >= ?)
         AND (? IS NULL OR created_at <= ?)`,
    )
    .get(chatId, from, from, to, to) as { n: number };
  return row.n;
}

/**
 * Bound the log: drop everything older than `maxAgeMs` and keep at most `keep`
 * lines per chat. Both bounds matter — age alone lets a busy chat balloon, count
 * alone keeps a quiet chat's year-old lines forever.
 */
export function pruneLog(chatId: number, keep: number, maxAgeMs?: number): void {
  const db = getDb();
  if (maxAgeMs !== undefined) {
    db.prepare('DELETE FROM chat_message_log WHERE chat_id = ? AND created_at < ?').run(
      chatId,
      Date.now() - maxAgeMs,
    );
  }
  db.prepare(
    `DELETE FROM chat_message_log
     WHERE chat_id = ?
       AND id NOT IN (
         SELECT id FROM chat_message_log
         WHERE chat_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )`,
  ).run(chatId, chatId, keep);
}

/** Wipe a chat's raw log (admin «забудь, что тут было»). */
export function clearLog(chatId: number): void {
  getDb().prepare('DELETE FROM chat_message_log WHERE chat_id = ?').run(chatId);
}

/** Oldest kept timestamp for a chat, or null when the log is empty. */
export function oldestLoggedAt(chatId: number): number | null {
  const row = getDb()
    .prepare('SELECT MIN(created_at) AS t FROM chat_message_log WHERE chat_id = ?')
    .get(chatId) as { t: number | null };
  return row.t ?? null;
}
