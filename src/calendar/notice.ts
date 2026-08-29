import { zonedParts, nextDateStr } from '../util/day.js';

// The "smart reminder" PLANNER — pure and deterministic, so «что и когда бот
// напомнит» is unit-testable without a DB or a clock. Three reminder kinds:
//
//  - evening : «завтра у тебя …» — fired once per evening (chat-local) when
//              tomorrow has events; flags an EARLY start so the advice line can
//              lean into prep («собери вещи с вечера, поставь будильник»).
//  - morning : «сегодня у тебя …» — fired once per morning for today's
//              remaining events.
//  - soon    : «через N минут …» — one ping per timed event shortly before it.
//
// Deduplication is by SLOT KEY, persisted in calendar_notice (survives
// restarts): a digest's slot is the local DATE it covers, a soon-ping's slot is
// the event occurrence itself. The planner never re-plans a sent slot.

export interface NoticeEvent {
  uid: string;
  title: string;
  location: string | null;
  /** ICS DESCRIPTION — often carries the booking details (terminal, seat,
   *  confirmation number) that make the advice line concrete. Never rendered
   *  into the digest itself; fed to the advice model only. */
  description?: string | null;
  startsAt: number;
  /** The event's own IANA zone from the feed (see calendar_event.tzid). Used as
   *  the rendering fallback while the CHAT's timezone is not set: showing a
   *  flight stored as 18:25 Asia/Saigon as «11:25» (UTC) invents a phantom
   *  discrepancy with the ticket. */
  tzid?: string | null;
  endsAt: number | null;
  allDay: boolean;
}

export type CalendarNotice =
  | {
      kind: 'evening' | 'morning';
      slot: string;
      /** The chat-local YYYY-MM-DD the digest covers. */
      dateStr: string;
      events: NoticeEvent[];
      /** Any timed event starts before the configured "early" hour. */
      hasEarly: boolean;
    }
  | { kind: 'soon'; slot: string; event: NoticeEvent; minutesLeft: number };

export interface NoticePlanArgs {
  events: NoticeEvent[];
  nowMs: number;
  tz: string;
  eveningHour: number;
  morningHour: number;
  earlyHour: number;
  soonMinutes: number;
  /** Lead for TRAVEL events (flights/trains — see isTravelEvent). A flight
   *  pinged 60 minutes before departure is a missed flight, not a reminder:
   *  by then the user must already be at the airport. Default handled by the
   *  caller (CALENDAR_SOON_TRAVEL_MINUTES, ~3h). */
  soonTravelMinutes?: number;
  /** Has this slot already been sent? (calendar_notice lookup.) */
  isSent: (slot: string) => boolean;
  /** False while the chat has not set its timezone (tz is then just the server
   *  default): day-bucketing and rendering fall back to each event's OWN zone. */
  tzKnown?: boolean;
}

// Deterministic "needs-a-long-runway" detector: flights, trains, airport-shaped
// events. Keyword-based over title + location (RU/EN) plus a flight-number shape
// («K6 829», «SU100»). Wrongly classifying a meeting as travel costs an early
// ping; wrongly classifying a flight as a meeting costs the flight — so the
// match is deliberately generous.
const TRAVEL_RE =
  /(рейс|самол[её]т|вылет|перел[её]т|аэропорт|аэроэкспресс|поезд|вокзал|паром|flight|airport|departure|boarding|train|ferry|✈)/i;
const FLIGHT_NO_RE = /\b[A-Z][A-Z0-9]\s?\d{2,4}\b/;

/** Does this event need the long (travel) pre-event lead? Pure; exported for tests. */
export function isTravelEvent(e: Pick<NoticeEvent, 'title' | 'location'>): boolean {
  const text = `${e.title} ${e.location ?? ''}`;
  return TRAVEL_RE.test(text) || FLIGHT_NO_RE.test(text);
}

/** «55 мин» / «3 ч» / «2 ч 40 мин» — a lead time the way a person says it. */
export function formatLead(minutes: number): string {
  if (minutes < 100) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem >= 10 ? `${h} ч ${rem} мин` : `${h} ч`;
}

/** Which zone to render/bucket an event in: the chat's, or — while the chat
 *  hasn't set one — the event's own zone from the calendar (when it has one). */
export function eventDisplayTz(e: NoticeEvent, tz: string, tzKnown: boolean): string {
  return tzKnown || !e.tzid ? tz : e.tzid;
}

/** The chat-local calendar date of an event. All-day events carry a bare DATE
 *  (stored as UTC midnight), so their date is read without tz conversion. */
export function eventLocalDate(e: NoticeEvent, tz: string, tzKnown = true): string {
  if (e.allDay) {
    const d = new Date(e.startsAt);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  return zonedParts(e.startsAt, eventDisplayTz(e, tz, tzKnown)).dateStr;
}

function hasEarlyStart(
  events: NoticeEvent[],
  tz: string,
  earlyHour: number,
  tzKnown: boolean,
): boolean {
  return events.some(
    (e) => !e.allDay && zonedParts(e.startsAt, eventDisplayTz(e, tz, tzKnown)).hour < earlyHour,
  );
}

export function planNotices(args: NoticePlanArgs): CalendarNotice[] {
  const { events, nowMs, tz } = args;
  const tzKnown = args.tzKnown ?? true;
  const now = zonedParts(nowMs, tz);
  const out: CalendarNotice[] = [];
  const byDate = (dateStr: string): NoticeEvent[] =>
    events
      .filter((e) => eventLocalDate(e, tz, tzKnown) === dateStr)
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt);

  // Evening digest for tomorrow, once the local evening hour is reached.
  if (now.hour >= args.eveningHour) {
    const tomorrow = nextDateStr(now.dateStr);
    const slot = `evening:${tomorrow}`;
    const tomorrowEvents = byDate(tomorrow);
    if (tomorrowEvents.length > 0 && !args.isSent(slot)) {
      out.push({
        kind: 'evening',
        slot,
        dateStr: tomorrow,
        events: tomorrowEvents,
        hasEarly: hasEarlyStart(tomorrowEvents, tz, args.earlyHour, tzKnown),
      });
    }
  }

  // Morning digest for today. Bounded above by the evening hour so a calendar
  // connected late at night doesn't fire «сегодня у тебя…» next to the evening
  // digest; only events that haven't started yet are listed.
  if (now.hour >= args.morningHour && now.hour < args.eveningHour) {
    const slot = `morning:${now.dateStr}`;
    const todays = byDate(now.dateStr).filter((e) => e.allDay || e.startsAt >= nowMs);
    if (todays.length > 0 && !args.isSent(slot)) {
      out.push({
        kind: 'morning',
        slot,
        dateStr: now.dateStr,
        events: todays,
        hasEarly: hasEarlyStart(todays, tz, args.earlyHour, tzKnown),
      });
    }
  }

  // Pre-event pings for timed events. An event already started is NOT pinged —
  // a "через -20 минут" reminder is worse than none. The lead is per EVENT
  // KIND: a meeting wants ~an hour, a flight wants hours (time to pack, get to
  // the airport, clear security — at T-60 the reminder is useless). The slot
  // key ignores the lead, so a travel event pings exactly once, early.
  const travelWindowMs = (args.soonTravelMinutes ?? args.soonMinutes) * 60_000;
  for (const e of events) {
    if (e.allDay) continue;
    const windowMs = isTravelEvent(e) ? Math.max(travelWindowMs, args.soonMinutes * 60_000) : args.soonMinutes * 60_000;
    const lead = e.startsAt - nowMs;
    if (lead < 0 || lead > windowMs) continue;
    const slot = `soon:${e.uid}:${e.startsAt}`;
    if (args.isSent(slot)) continue;
    out.push({ kind: 'soon', slot, event: e, minutesLeft: Math.max(1, Math.ceil(lead / 60_000)) });
  }

  return out;
}

// --- deterministic rendering ------------------------------------------------
// The digest LIST is rendered here, never by a model: titles, times and places
// reach the chat exactly as the calendar states them. The optional LLM line
// (see src/llm/calendarAdvice.ts) is appended UNDER this text and cannot touch it.

function timeInTz(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** «сб, 30 августа» for a chat-local YYYY-MM-DD. */
export function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    }).format(new Date(Date.UTC(y!, m! - 1, d!)));
  } catch {
    return dateStr;
  }
}

/** One event as a digest line: «07:40 Самолёт в Москву — Шереметьево». */
export function renderEventLine(e: NoticeEvent, tz: string, tzKnown = true): string {
  const when = e.allDay ? 'весь день' : timeInTz(e.startsAt, eventDisplayTz(e, tz, tzKnown));
  const place = e.location ? ` — ${e.location}` : '';
  return `${when} ${e.title}${place}`;
}

/** One line telling the user their chat has no timezone yet — appended wherever
 *  event times had to fall back to the events' own zones. */
export const TZ_UNSET_FOOTNOTE =
  '⏱ Часовой пояс чата не задан — время каждого события показано в его зоне из календаря (или UTC). Скажи мне, например, «я во Вьетнаме» — начну показывать всё по местному.';

/** The deterministic body of a notice (the advice line is appended by the sender). */
export function renderNotice(notice: CalendarNotice, tz: string, tzKnown = true): string {
  if (notice.kind === 'soon') {
    const e = notice.event;
    const place = e.location ? ` — ${e.location}` : '';
    const dtz = eventDisplayTz(e, tz, tzKnown);
    const zone = tzKnown ? '' : ` ${dtz}`;
    return `⏰ Через ${formatLead(notice.minutesLeft)}: «${e.title}»${place} (в ${timeInTz(e.startsAt, dtz)}${zone})`;
  }
  const header =
    notice.kind === 'evening'
      ? `🗓 Завтра (${dayLabel(notice.dateStr)}) по календарю:`
      : `🗓 Сегодня (${dayLabel(notice.dateStr)}) по календарю:`;
  const lines = notice.events.map((e) => `• ${renderEventLine(e, tz, tzKnown)}`);
  const foot = tzKnown ? [] : ['', TZ_UNSET_FOOTNOTE];
  return [header, ...lines, ...foot].join('\n');
}
