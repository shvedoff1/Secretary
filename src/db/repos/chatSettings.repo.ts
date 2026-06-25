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

/** Per-chat configuration for the daily spending digest. */
export interface DailySpendingSettings {
  chatId: number;
  enabled: boolean;
  /** Local hour (0–23) at which the previous day's digest is posted. */
  hour: number;
  /** Local minute (0–59). */
  minute: number;
  /** Last report date posted (YYYY-MM-DD, chat-local), or null if never. */
  lastDate: string | null;
}

interface DailySpendingRow {
  chat_id: number;
  daily_spending_enabled: number;
  daily_spending_hour: number;
  daily_spending_minute: number;
  daily_spending_last_date: string | null;
}

function toSettings(row: DailySpendingRow): DailySpendingSettings {
  return {
    chatId: row.chat_id,
    enabled: row.daily_spending_enabled === 1,
    hour: row.daily_spending_hour,
    minute: row.daily_spending_minute,
    lastDate: row.daily_spending_last_date,
  };
}

const DAILY_COLS =
  'chat_id, daily_spending_enabled, daily_spending_hour, daily_spending_minute, daily_spending_last_date';

/** Daily-digest settings for one chat, or null if the chat has no settings row. */
export function getDailySpending(chatId: number): DailySpendingSettings | null {
  const row = getDb()
    .prepare(`SELECT ${DAILY_COLS} FROM chat_settings WHERE chat_id = ?`)
    .get(chatId) as DailySpendingRow | undefined;
  return row ? toSettings(row) : null;
}

/** Every chat with the daily digest currently enabled. */
export function listDailySpendingEnabled(): DailySpendingSettings[] {
  const rows = getDb()
    .prepare(
      `SELECT ${DAILY_COLS} FROM chat_settings WHERE daily_spending_enabled = 1`,
    )
    .all() as DailySpendingRow[];
  return rows.map(toSettings);
}

/**
 * Enable/disable the digest. When enabling, the caller passes the chat-local
 * `lastDate` to seed the "already posted" guard so the feature starts cleanly
 * the next morning instead of immediately back-filling.
 */
export function setDailySpendingEnabled(
  chatId: number,
  enabled: boolean,
  opts: { hour?: number; minute?: number; lastDate?: string | null } = {},
): void {
  const hour = opts.hour ?? 9;
  const minute = opts.minute ?? 0;
  const lastDate = opts.lastDate ?? null;
  getDb()
    .prepare(
      `INSERT INTO chat_settings
         (chat_id, daily_spending_enabled, daily_spending_hour, daily_spending_minute, daily_spending_last_date, updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         daily_spending_enabled = excluded.daily_spending_enabled,
         daily_spending_hour = excluded.daily_spending_hour,
         daily_spending_minute = excluded.daily_spending_minute,
         daily_spending_last_date = excluded.daily_spending_last_date,
         updated_at = excluded.updated_at`,
    )
    .run(chatId, enabled ? 1 : 0, hour, minute, lastDate);
}

/** Record the most recent report date posted (prevents double-posting). */
export function setDailySpendingLastDate(chatId: number, date: string): void {
  getDb()
    .prepare(
      `UPDATE chat_settings
         SET daily_spending_last_date = ?, updated_at = unixepoch() * 1000
       WHERE chat_id = ?`,
    )
    .run(date, chatId);
}
