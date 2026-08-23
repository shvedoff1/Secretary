import { getDb } from '../client.js';

export interface ChatAdminRow {
  chat_id: number;
  tg_user_id: number;
  granted_by: number | null;
  granted_at: number;
}

/** Grant a user chat-admin rights for one chat (idempotent). */
export function addChatAdmin(chatId: number, tgUserId: number, grantedBy: number | null): void {
  getDb()
    .prepare(
      `INSERT INTO chat_admin (chat_id, tg_user_id, granted_by, granted_at)
       VALUES (?, ?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id, tg_user_id) DO NOTHING`,
    )
    .run(chatId, tgUserId, grantedBy);
}

/** Revoke chat-admin rights. Returns true when a grant actually existed. */
export function removeChatAdmin(chatId: number, tgUserId: number): boolean {
  const res = getDb()
    .prepare('DELETE FROM chat_admin WHERE chat_id = ? AND tg_user_id = ?')
    .run(chatId, tgUserId);
  return res.changes > 0;
}

export function isChatAdmin(tgUserId: number, chatId: number): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM chat_admin WHERE chat_id = ? AND tg_user_id = ?')
    .get(chatId, tgUserId);
}

/** All admins of one chat, oldest grant first. */
export function listChatAdmins(chatId: number): ChatAdminRow[] {
  return getDb()
    .prepare('SELECT * FROM chat_admin WHERE chat_id = ? ORDER BY granted_at')
    .all(chatId) as ChatAdminRow[];
}

/** All chats one user administers, oldest grant first. */
export function listManagedChats(tgUserId: number): number[] {
  return (
    getDb()
      .prepare('SELECT chat_id FROM chat_admin WHERE tg_user_id = ? ORDER BY granted_at')
      .all(tgUserId) as { chat_id: number }[]
  ).map((r) => r.chat_id);
}

export function countManagedChats(tgUserId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM chat_admin WHERE tg_user_id = ?')
    .get(tgUserId) as { n: number };
  return row.n;
}
