import { getDb } from '../client.js';

/** The chat's IANA timezone, or null if not set yet. */
export function getTimezone(chatId: number): string | null {
  const row = getDb()
    .prepare('SELECT timezone FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { timezone: string | null } | undefined;
  return row?.timezone ?? null;
}

export function setTimezone(chatId: number, timezone: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, timezone, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         timezone = excluded.timezone, updated_at = excluded.updated_at`,
    )
    .run(chatId, timezone);
}

/**
 * How the assistant behaves in this chat. 'secretary' is the default chill
 * assistant; 'tutor' is the strict accuracy-first study tutor (no humor/slang,
 * no expense/surf skills — just precise dialogue and problem solving).
 */
export type ChatMode = 'secretary' | 'tutor';

export function getChatMode(chatId: number): ChatMode {
  const row = getDb()
    .prepare('SELECT mode FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { mode: string | null } | undefined;
  return row?.mode === 'tutor' ? 'tutor' : 'secretary';
}

export function setChatMode(chatId: number, mode: ChatMode): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, mode, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         mode = excluded.mode, updated_at = excluded.updated_at`,
    )
    .run(chatId, mode);
}
