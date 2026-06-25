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
