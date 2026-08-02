import { getDb } from '../client.js';

export interface PageWatch {
  id: number;
  chatId: number;
  tgUserId: number | null;
  title: string;
  url: string;
  /** The awaited event in plain words — what the checking model verifies. */
  condition: string;
  /** Lowercase substrings that must appear on the page before the LLM check runs. */
  keywords: string[];
  intervalMinutes: number;
  expiresAt: number;
  enabled: boolean;
  nextCheckAt: number;
  lastCheckedAt: number | null;
  lastHash: string | null;
  failCount: number;
  firedAt: number | null;
  createdAt: number;
}

interface PageWatchRow {
  id: number;
  chat_id: number;
  tg_user_id: number | null;
  title: string;
  url: string;
  condition: string;
  keywords: string;
  interval_minutes: number;
  expires_at: number;
  enabled: number;
  next_check_at: number;
  last_checked_at: number | null;
  last_hash: string | null;
  fail_count: number;
  fired_at: number | null;
  created_at: number;
}

function parseKeywords(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}

function toWatch(r: PageWatchRow): PageWatch {
  return {
    id: r.id,
    chatId: r.chat_id,
    tgUserId: r.tg_user_id,
    title: r.title,
    url: r.url,
    condition: r.condition,
    keywords: parseKeywords(r.keywords),
    intervalMinutes: r.interval_minutes,
    expiresAt: r.expires_at,
    enabled: r.enabled === 1,
    nextCheckAt: r.next_check_at,
    lastCheckedAt: r.last_checked_at,
    lastHash: r.last_hash,
    failCount: r.fail_count,
    firedAt: r.fired_at,
    createdAt: r.created_at,
  };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeCondition(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Find an existing active watch that is effectively the same as a candidate —
 * same page + same awaited event. Guards against the model re-creating a watch it
 * already made (e.g. when the original request lingers in conversation history).
 * Pure function over a watch list so it can be unit-tested without a DB.
 */
export function findDuplicateWatch(
  watches: PageWatch[],
  candidate: { url: string; condition: string },
): PageWatch | undefined {
  const url = normalizeUrl(candidate.url);
  const cond = normalizeCondition(candidate.condition);
  return watches.find(
    (w) =>
      w.enabled && normalizeUrl(w.url) === url && normalizeCondition(w.condition) === cond,
  );
}

export function createWatch(args: {
  chatId: number;
  tgUserId: number | null;
  title: string;
  url: string;
  condition: string;
  keywords: string[];
  intervalMinutes: number;
  expiresAt: number;
  nextCheckAt: number;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO page_watch
         (chat_id, tg_user_id, title, url, condition, keywords, interval_minutes,
          expires_at, enabled, next_check_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch() * 1000)`,
    )
    .run(
      args.chatId,
      args.tgUserId,
      args.title,
      args.url,
      args.condition,
      JSON.stringify(args.keywords),
      args.intervalMinutes,
      args.expiresAt,
      args.nextCheckAt,
    );
  return Number(info.lastInsertRowid);
}

/** Active watches for a chat, next-check-soonest first. */
export function listWatches(chatId: number): PageWatch[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM page_watch
       WHERE chat_id = ? AND enabled = 1
       ORDER BY next_check_at ASC`,
    )
    .all(chatId) as PageWatchRow[];
  return rows.map(toWatch);
}

/** All enabled watches whose next check is due (<= now). */
export function dueWatches(nowMs: number): PageWatch[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM page_watch
       WHERE enabled = 1 AND next_check_at <= ?
       ORDER BY next_check_at ASC`,
    )
    .all(nowMs) as PageWatchRow[];
  return rows.map(toWatch);
}

/** Record the outcome of one poll and schedule the next. */
export function setCheckResult(
  id: number,
  args: { nextCheckAt: number; lastCheckedAt: number; lastHash: string | null; failCount: number },
): void {
  getDb()
    .prepare(
      `UPDATE page_watch
       SET next_check_at = ?, last_checked_at = ?, last_hash = ?, fail_count = ?
       WHERE id = ?`,
    )
    .run(args.nextCheckAt, args.lastCheckedAt, args.lastHash, args.failCount, id);
}

/** Disarm a watch; pass firedAt when the awaited event was actually detected. */
export function disableWatch(id: number, firedAt?: number): void {
  if (firedAt !== undefined) {
    getDb()
      .prepare('UPDATE page_watch SET enabled = 0, fired_at = ? WHERE id = ?')
      .run(firedAt, id);
  } else {
    getDb().prepare('UPDATE page_watch SET enabled = 0 WHERE id = ?').run(id);
  }
}

/** Delete a watch, scoped to its chat so users can only remove their own chat's watches. */
export function deleteWatch(id: number, chatId: number): boolean {
  const info = getDb()
    .prepare('DELETE FROM page_watch WHERE id = ? AND chat_id = ?')
    .run(id, chatId);
  return info.changes > 0;
}

/**
 * Force a watch's next poll to "now" (the /watch check command), so the next
 * runner tick (within a minute) picks it up. Scoped to the chat; enabled only.
 */
export function forceCheck(id: number, chatId: number): boolean {
  const info = getDb()
    .prepare(
      'UPDATE page_watch SET next_check_at = 0 WHERE id = ? AND chat_id = ? AND enabled = 1',
    )
    .run(id, chatId);
  return info.changes > 0;
}
