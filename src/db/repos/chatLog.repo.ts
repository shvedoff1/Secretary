import { getDb } from '../client.js';

export type LogRole = 'user' | 'assistant';
/** Channel the line came through — a voice note reads differently from a caption. */
export type LogKind = 'text' | 'voice' | 'photo' | 'file' | 'video';

export interface LoggedMessage {
  id: number;
  role: LogRole;
  kind: LogKind;
  tgUserId: number | null;
  /** Author's display name; null for the bot's own posts. */
  senderName: string | null;
  content: string;
  createdAt: number;
  /** Forum topic the line was posted in; null outside forums / in General. */
  threadId: number | null;
  /** Telegram message id (for links back to the source); null for old rows. */
  messageId: number | null;
  /** A cheap-to-open file_id for media lines (photo / video thumbnail / image file). */
  mediaFileId: string | null;
}

/** Filters a log read can be narrowed by (all optional). */
export interface LogFilter {
  fromMs?: number | null;
  toMs?: number | null;
  /** Forum topic id; 0 = the General topic (stored as NULL). Undefined/null = all. */
  threadId?: number | null;
  /** Only these channels (e.g. ['voice'] for «из голосовых»). Empty/undefined = all. */
  kinds?: readonly LogKind[] | null;
}

/** SQL fragment + params for a LogFilter (after `WHERE chat_id = ?`). */
function filterSql(f: LogFilter): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (f.fromMs != null) {
    parts.push('created_at >= ?');
    params.push(f.fromMs);
  }
  if (f.toMs != null) {
    parts.push('created_at <= ?');
    params.push(f.toMs);
  }
  if (f.threadId != null) {
    if (f.threadId === 0) parts.push('thread_id IS NULL');
    else {
      parts.push('thread_id = ?');
      params.push(f.threadId);
    }
  }
  if (f.kinds && f.kinds.length > 0) {
    parts.push(`kind IN (${f.kinds.map(() => '?').join(', ')})`);
    params.push(...f.kinds);
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(''), params };
}

interface LogRow {
  id: number;
  role: LogRole;
  kind: LogKind;
  tg_user_id: number | null;
  sender_name: string | null;
  content: string;
  created_at: number;
  thread_id: number | null;
  message_id: number | null;
  media_file_id: string | null;
}

const LOG_COLUMNS =
  'id, role, kind, tg_user_id, sender_name, content, created_at, thread_id, message_id, media_file_id';

function toMessage(r: LogRow): LoggedMessage {
  return {
    id: r.id,
    role: r.role,
    kind: r.kind,
    tgUserId: r.tg_user_id,
    senderName: r.sender_name,
    content: r.content,
    createdAt: r.created_at,
    threadId: r.thread_id,
    messageId: r.message_id,
    mediaFileId: r.media_file_id,
  };
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
  threadId?: number | null;
  messageId?: number | null;
  mediaFileId?: string | null;
  /** Test seam: explicit timestamp. Defaults to now. */
  createdAt?: number;
}): void {
  const text = args.content.trim();
  if (!text) return;
  getDb()
    .prepare(
      `INSERT INTO chat_message_log
         (chat_id, tg_user_id, sender_name, role, kind, content, created_at, thread_id, message_id, media_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.chatId,
      args.tgUserId,
      args.senderName ?? null,
      args.role,
      args.kind ?? 'text',
      text,
      args.createdAt ?? Date.now(),
      args.threadId ?? null,
      args.messageId ?? null,
      args.mediaFileId ?? null,
    );
}

/**
 * Read a window of the log back, oldest first — the shape a transcript is rendered
 * from. `limit` counts from the NEWEST end (the last N messages), so a window is
 * always "the most recent N of the range", never the first N of it.
 */
export function readLog(
  chatId: number,
  opts: { limit: number } & LogFilter,
): LoggedMessage[] {
  const f = filterSql(opts);
  const rows = getDb()
    .prepare(
      `SELECT ${LOG_COLUMNS}
       FROM chat_message_log
       WHERE chat_id = ?${f.sql}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(chatId, ...f.params, opts.limit) as LogRow[];
  return rows.map(toMessage).reverse();
}

/** How many lines the log holds for a chat (optionally within a window). */
export function countLog(chatId: number, opts: LogFilter = {}): number {
  const f = filterSql(opts);
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM chat_message_log WHERE chat_id = ?${f.sql}`)
    .get(chatId, ...f.params) as { n: number };
  return row.n;
}

/**
 * One logged line by its log id, scoped to the chat — what `view_media` opens.
 * Chat-scoped so a ref from one chat can never open another chat's picture.
 */
export function getLogEntry(chatId: number, id: number): LoggedMessage | null {
  const row = getDb()
    .prepare(`SELECT ${LOG_COLUMNS} FROM chat_message_log WHERE chat_id = ? AND id = ?`)
    .get(chatId, id) as LogRow | undefined;
  return row ? toMessage(row) : null;
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

/** A group chat whose log can be read (titles from chat_settings, best-effort). */
export interface LoggedChat {
  chatId: number;
  title: string | null;
}

/**
 * Group chats that HAVE a log, with their titles — the pool a «что там в рабочем
 * чате» asked from the DM is resolved against. Resolution is not access: the
 * caller still checks the asker is a member before reading a line.
 */
export function listLoggedChats(): LoggedChat[] {
  return (
    getDb()
      .prepare(
        `SELECT l.chat_id AS chat_id, s.title AS title
         FROM (SELECT DISTINCT chat_id FROM chat_message_log WHERE chat_id < 0) l
         LEFT JOIN chat_settings s ON s.chat_id = l.chat_id`,
      )
      .all() as { chat_id: number; title: string | null }[]
  ).map((r) => ({ chatId: r.chat_id, title: r.title }));
}

/**
 * Group chats where this person has posted something that is still in the log —
 * the cheap, DB-only list the DM context block shows («из лички можно спросить
 * про…»). No Telegram calls per turn; membership is checked only on an actual read.
 */
export function loggedChatsOfUser(tgUserId: number, limit = 10): LoggedChat[] {
  return (
    getDb()
      .prepare(
        `SELECT l.chat_id AS chat_id, s.title AS title
         FROM (
           SELECT chat_id, MAX(created_at) AS last_at FROM chat_message_log
           WHERE tg_user_id = ? AND chat_id < 0
           GROUP BY chat_id
         ) l
         LEFT JOIN chat_settings s ON s.chat_id = l.chat_id
         ORDER BY l.last_at DESC
         LIMIT ?`,
      )
      .all(tgUserId, limit) as { chat_id: number; title: string | null }[]
  ).map((r) => ({ chatId: r.chat_id, title: r.title }));
}

/** One logged line by id regardless of chat — the caller MUST check access to its chat. */
export function getLogEntryUnscoped(id: number): (LoggedMessage & { chatId: number }) | null {
  const row = getDb()
    .prepare(`SELECT ${LOG_COLUMNS}, chat_id FROM chat_message_log WHERE id = ?`)
    .get(id) as (LogRow & { chat_id: number }) | undefined;
  return row ? { ...toMessage(row), chatId: row.chat_id } : null;
}
