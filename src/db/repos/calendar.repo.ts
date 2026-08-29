import { getDb } from '../client.js';

// Google-Calendar connection storage («календарь»). SECURITY INVARIANT: every
// read here is keyed by chat_id (events are denormalised with it), so a
// calendar's data can only ever be served into the chat it was connected to —
// the isolation is enforced at the query layer, not left to callers.

export interface ChatCalendar {
  id: number;
  chatId: number;
  tgUserId: number | null;
  name: string;
  /** The SECRET private ICS address. Never show it in full — use maskIcsUrl. */
  icsUrl: string;
  enabled: boolean;
  nextFetchAt: number;
  lastFetchAt: number | null;
  lastOkAt: number | null;
  failCount: number;
  createdAt: number;
}

interface CalendarRow {
  id: number;
  chat_id: number;
  tg_user_id: number | null;
  name: string;
  ics_url: string;
  enabled: number;
  next_fetch_at: number;
  last_fetch_at: number | null;
  last_ok_at: number | null;
  fail_count: number;
  created_at: number;
}

export interface CalendarEvent {
  id: number;
  calendarId: number;
  chatId: number;
  uid: string;
  title: string;
  location: string | null;
  description: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  /** The event's own IANA zone from the feed (null = UTC/floating/all-day). */
  tzid: string | null;
}

interface EventRow {
  id: number;
  calendar_id: number;
  chat_id: number;
  uid: string;
  title: string;
  location: string | null;
  description: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  tzid: string | null;
}

function toCalendar(r: CalendarRow): ChatCalendar {
  return {
    id: r.id,
    chatId: r.chat_id,
    tgUserId: r.tg_user_id,
    name: r.name,
    icsUrl: r.ics_url,
    enabled: r.enabled === 1,
    nextFetchAt: r.next_fetch_at,
    lastFetchAt: r.last_fetch_at,
    lastOkAt: r.last_ok_at,
    failCount: r.fail_count,
    createdAt: r.created_at,
  };
}

function toEvent(r: EventRow): CalendarEvent {
  return {
    id: r.id,
    calendarId: r.calendar_id,
    chatId: r.chat_id,
    uid: r.uid,
    title: r.title,
    location: r.location,
    description: r.description,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: r.all_day === 1,
    tzid: r.tzid,
  };
}

/**
 * Mask a secret ICS URL for display: host plus the tail of the path. The full
 * URL grants read access to the whole calendar, so it must never be echoed back
 * into a chat (where anyone scrolling by could copy it).
 */
export function maskIcsUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^webcal:/i, 'https:'));
    const tail = u.pathname.length > 8 ? `…${u.pathname.slice(-8)}` : u.pathname;
    return `${u.host}/${tail.replace(/^\/+/, '')}`;
  } catch {
    return url.length > 24 ? `${url.slice(0, 12)}…${url.slice(-8)}` : url;
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/^webcal:/i, 'https:');
}

export function addCalendar(args: {
  chatId: number;
  tgUserId: number | null;
  name: string;
  icsUrl: string;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO chat_calendar (chat_id, tg_user_id, name, ics_url, enabled, next_fetch_at, created_at)
       VALUES (?, ?, ?, ?, 1, 0, unixepoch() * 1000)`,
    )
    .run(args.chatId, args.tgUserId, args.name, normalizeUrl(args.icsUrl));
  return Number(info.lastInsertRowid);
}

/** An enabled calendar in this chat with the same (normalized) URL, if any. */
export function findCalendarByUrl(chatId: number, icsUrl: string): ChatCalendar | undefined {
  const target = normalizeUrl(icsUrl);
  return listCalendars(chatId).find((c) => normalizeUrl(c.icsUrl) === target);
}

export function listCalendars(chatId: number): ChatCalendar[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_calendar WHERE chat_id = ? AND enabled = 1 ORDER BY id')
    .all(chatId) as CalendarRow[];
  return rows.map(toCalendar);
}

/**
 * Disconnect a calendar. Scoped to its chat so a user can only ever remove their
 * own chat's calendars; the cached events go with it (they exist only as a view
 * of the feed).
 */
export function deleteCalendar(id: number, chatId: number): boolean {
  const db = getDb();
  const run = db.transaction(() => {
    const info = db
      .prepare('DELETE FROM chat_calendar WHERE id = ? AND chat_id = ?')
      .run(id, chatId);
    if (info.changes === 0) return false;
    db.prepare('DELETE FROM calendar_event WHERE calendar_id = ? AND chat_id = ?').run(
      id,
      chatId,
    );
    return true;
  });
  return run();
}

/** All enabled calendars whose next fetch is due (<= now). */
export function dueCalendars(nowMs: number): ChatCalendar[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM chat_calendar WHERE enabled = 1 AND next_fetch_at <= ? ORDER BY next_fetch_at',
    )
    .all(nowMs) as CalendarRow[];
  return rows.map(toCalendar);
}

/** Record the outcome of one fetch and schedule the next. */
export function setFetchResult(
  id: number,
  args: { ok: boolean; nowMs: number; nextFetchAt: number; failCount: number },
): void {
  getDb()
    .prepare(
      `UPDATE chat_calendar
       SET next_fetch_at = ?, last_fetch_at = ?, fail_count = ?,
           last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END
       WHERE id = ?`,
    )
    .run(args.nextFetchAt, args.nowMs, args.failCount, args.ok ? 1 : 0, args.nowMs, id);
}

/** Force a chat's calendars to re-fetch on the next minute tick. */
export function forceFetch(chatId: number): number {
  const info = getDb()
    .prepare('UPDATE chat_calendar SET next_fetch_at = 0 WHERE chat_id = ? AND enabled = 1')
    .run(chatId);
  return info.changes;
}

/**
 * Replace a calendar's cached window with a fresh expansion. One transaction so
 * a reader never sees a half-swapped window.
 */
export function replaceEvents(
  calendarId: number,
  chatId: number,
  events: {
    uid: string;
    title: string;
    location: string | null;
    description: string | null;
    startsAt: number;
    endsAt: number | null;
    allDay: boolean;
    tzid: string | null;
  }[],
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO calendar_event
       (calendar_id, chat_id, uid, title, location, description, starts_at, ends_at, all_day, tzid, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)`,
  );
  const run = db.transaction(() => {
    db.prepare('DELETE FROM calendar_event WHERE calendar_id = ? AND chat_id = ?').run(
      calendarId,
      chatId,
    );
    for (const e of events) {
      insert.run(
        calendarId,
        chatId,
        e.uid,
        e.title,
        e.location,
        e.description,
        e.startsAt,
        e.endsAt,
        e.allDay ? 1 : 0,
        e.tzid,
      );
    }
  });
  run();
}

/** Cached events of THIS chat inside [fromMs, toMs), soonest first. */
export function listEvents(chatId: number, fromMs: number, toMs: number): CalendarEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM calendar_event
       WHERE chat_id = ? AND starts_at >= ? AND starts_at < ?
       ORDER BY starts_at, id`,
    )
    .all(chatId, fromMs, toMs) as EventRow[];
  return rows.map(toEvent);
}

/** Chats that have at least one enabled calendar (the reminder tick iterates these). */
export function chatsWithCalendars(): number[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT chat_id FROM chat_calendar WHERE enabled = 1')
    .all() as { chat_id: number }[];
  return rows.map((r) => r.chat_id);
}

/** Has this notice slot already been sent to this chat? */
export function wasNoticeSent(chatId: number, slot: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM calendar_notice WHERE chat_id = ? AND slot = ?')
    .get(chatId, slot) as { x: number } | undefined;
  return !!row;
}

export function markNoticeSent(chatId: number, slot: string, nowMs: number): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO calendar_notice (chat_id, slot, sent_at) VALUES (?, ?, ?)',
    )
    .run(chatId, slot, nowMs);
}

/** Drop notice slots older than the cutoff (they can never be re-planned). */
export function pruneNotices(olderThanMs: number): number {
  const info = getDb()
    .prepare('DELETE FROM calendar_notice WHERE sent_at < ?')
    .run(olderThanMs);
  return info.changes;
}
