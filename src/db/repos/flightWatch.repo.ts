import { getDb } from '../client.js';
import type { FlightSnapshot } from '../../flight/status.js';

export interface FlightWatch {
  id: number;
  chatId: number;
  tgUserId: number | null;
  title: string;
  /** Normalized IATA flight number, e.g. "K6829". */
  flight: string;
  /** YYYY-MM-DD the user asked about, or null for "the nearest leg". */
  flightDate: string | null;
  intervalMinutes: number;
  expiresAt: number;
  enabled: boolean;
  nextCheckAt: number;
  lastCheckedAt: number | null;
  /** Baseline snapshot the next poll is diffed against (null before the first data). */
  lastSnapshot: FlightSnapshot | null;
  failCount: number;
  firedAt: number | null;
  createdAt: number;
}

interface FlightWatchRow {
  id: number;
  chat_id: number;
  tg_user_id: number | null;
  title: string;
  flight: string;
  flight_date: string | null;
  interval_minutes: number;
  expires_at: number;
  enabled: number;
  next_check_at: number;
  last_checked_at: number | null;
  last_snapshot: string | null;
  fail_count: number;
  fired_at: number | null;
  created_at: number;
}

function parseSnapshot(json: string | null): FlightSnapshot | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as FlightSnapshot;
  } catch {
    return null;
  }
}

function toWatch(r: FlightWatchRow): FlightWatch {
  return {
    id: r.id,
    chatId: r.chat_id,
    tgUserId: r.tg_user_id,
    title: r.title,
    flight: r.flight,
    flightDate: r.flight_date,
    intervalMinutes: r.interval_minutes,
    expiresAt: r.expires_at,
    enabled: r.enabled === 1,
    nextCheckAt: r.next_check_at,
    lastCheckedAt: r.last_checked_at,
    lastSnapshot: parseSnapshot(r.last_snapshot),
    failCount: r.fail_count,
    firedAt: r.fired_at,
    createdAt: r.created_at,
  };
}

/**
 * Find an existing active watch on the same flight (and same date, where both
 * name one). Guards against the model re-arming a watch it already created when
 * the original request lingers in conversation history. Pure over a list so it
 * can be unit-tested without a DB.
 */
export function findDuplicateFlightWatch(
  watches: FlightWatch[],
  candidate: { flight: string; flightDate: string | null },
): FlightWatch | undefined {
  return watches.find(
    (w) =>
      w.enabled &&
      w.flight === candidate.flight &&
      // A dated watch and an undated one on the same flight are the same ask in
      // practice — the undated watch already follows the nearest leg.
      (w.flightDate === candidate.flightDate ||
        w.flightDate === null ||
        candidate.flightDate === null),
  );
}

export function createFlightWatch(args: {
  chatId: number;
  tgUserId: number | null;
  title: string;
  flight: string;
  flightDate: string | null;
  intervalMinutes: number;
  expiresAt: number;
  nextCheckAt: number;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO flight_watch
         (chat_id, tg_user_id, title, flight, flight_date, interval_minutes,
          expires_at, enabled, next_check_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch() * 1000)`,
    )
    .run(
      args.chatId,
      args.tgUserId,
      args.title,
      args.flight,
      args.flightDate,
      args.intervalMinutes,
      args.expiresAt,
      args.nextCheckAt,
    );
  return Number(info.lastInsertRowid);
}

/** Active flight watches for a chat, next-check-soonest first. */
export function listFlightWatches(chatId: number): FlightWatch[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM flight_watch
       WHERE chat_id = ? AND enabled = 1
       ORDER BY next_check_at ASC`,
    )
    .all(chatId) as FlightWatchRow[];
  return rows.map(toWatch);
}

/** All enabled flight watches whose next check is due (<= now). */
export function dueFlightWatches(nowMs: number): FlightWatch[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM flight_watch
       WHERE enabled = 1 AND next_check_at <= ?
       ORDER BY next_check_at ASC`,
    )
    .all(nowMs) as FlightWatchRow[];
  return rows.map(toWatch);
}

/** Record the outcome of one poll and schedule the next. */
export function setFlightCheckResult(
  id: number,
  args: {
    nextCheckAt: number;
    lastCheckedAt: number;
    lastSnapshot: FlightSnapshot | null;
    failCount: number;
  },
): void {
  getDb()
    .prepare(
      `UPDATE flight_watch
       SET next_check_at = ?, last_checked_at = ?, last_snapshot = ?, fail_count = ?
       WHERE id = ?`,
    )
    .run(
      args.nextCheckAt,
      args.lastCheckedAt,
      args.lastSnapshot ? JSON.stringify(args.lastSnapshot) : null,
      args.failCount,
      id,
    );
}

/** Disarm a watch; pass firedAt when a terminal event (cancel/landing) was delivered. */
export function disableFlightWatch(id: number, firedAt?: number): void {
  if (firedAt !== undefined) {
    getDb()
      .prepare('UPDATE flight_watch SET enabled = 0, fired_at = ? WHERE id = ?')
      .run(firedAt, id);
  } else {
    getDb().prepare('UPDATE flight_watch SET enabled = 0 WHERE id = ?').run(id);
  }
}

/** Delete a watch, scoped to its chat so users can only remove their own chat's watches. */
export function deleteFlightWatch(id: number, chatId: number): boolean {
  const info = getDb()
    .prepare('DELETE FROM flight_watch WHERE id = ? AND chat_id = ?')
    .run(id, chatId);
  return info.changes > 0;
}

/**
 * Force a watch's next poll to "now" (the /flight check command), so the next
 * runner tick (within a minute) picks it up. Scoped to the chat; enabled only.
 */
export function forceFlightCheck(id: number, chatId: number): boolean {
  const info = getDb()
    .prepare(
      'UPDATE flight_watch SET next_check_at = 0 WHERE id = ? AND chat_id = ? AND enabled = 1',
    )
    .run(id, chatId);
  return info.changes > 0;
}
