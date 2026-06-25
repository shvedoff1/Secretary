import { getDb } from '../client.js';

export type TurnRole = 'user' | 'assistant';

export interface Turn {
  role: TurnRole;
  tgUserId: number | null;
  content: string;
  createdAt: number;
}

export function addTurn(args: {
  chatId: number;
  role: TurnRole;
  tgUserId: number | null;
  content: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_turn (chat_id, role, tg_user_id, content, created_at)
       VALUES (?, ?, ?, ?, unixepoch() * 1000)`,
    )
    .run(args.chatId, args.role, args.tgUserId, args.content);
}

/**
 * Most recent `limit` turns, returned in chronological order. When `maxAgeMs` is
 * given, turns older than that are excluded — so a long-ago tangent expires out of
 * the window on its own instead of lingering until enough new exchanges push it out.
 */
export function recentTurns(chatId: number, limit: number, maxAgeMs?: number): Turn[] {
  const cutoff = maxAgeMs !== undefined ? Date.now() - maxAgeMs : null;
  const rows = getDb()
    .prepare(
      `SELECT role, tg_user_id, content, created_at
       FROM conversation_turn
       WHERE chat_id = ?
         AND (? IS NULL OR created_at >= ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(chatId, cutoff, cutoff, limit) as {
    role: TurnRole;
    tg_user_id: number | null;
    content: string;
    created_at: number;
  }[];
  return rows
    .map((r) => ({
      role: r.role,
      tgUserId: r.tg_user_id,
      content: r.content,
      createdAt: r.created_at,
    }))
    .reverse();
}

/** Keep only the newest `keep` turns per chat; delete the rest. */
export function pruneOld(chatId: number, keep: number): void {
  getDb()
    .prepare(
      `DELETE FROM conversation_turn
       WHERE chat_id = ?
         AND id NOT IN (
           SELECT id FROM conversation_turn
           WHERE chat_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )`,
    )
    .run(chatId, chatId, keep);
}

/** Wipe all dialogue history for a chat. */
export function clearTurns(chatId: number): void {
  getDb()
    .prepare('DELETE FROM conversation_turn WHERE chat_id = ?')
    .run(chatId);
}
