import { zonedTimeToUtcMs } from '../util/day.js';

// Pure ICS (iCalendar) parser + recurrence expansion for the calendar feature.
// Deliberately dependency-free and PRAGMATIC: it targets what Google Calendar's
// «секретный адрес в формате iCal» actually exports for human events — one-off
// events, DAILY/WEEKLY/MONTHLY/YEARLY recurrences with INTERVAL/BYDAY/BYMONTHDAY/
// COUNT/UNTIL, EXDATE exceptions and RECURRENCE-ID overrides. A rule that uses
// parts we do not implement (BYSETPOS, BYHOUR, …) is NOT guessed at: guessing
// yields events on WRONG dates, and a wrong reminder is worse than a missed one —
// such an event contributes only occurrences we can derive safely (its DTSTART
// and any RDATE/override instances).

export interface IcsOccurrence {
  uid: string;
  title: string;
  location: string | null;
  description: string | null;
  /** UTC ms. For an all-day event: UTC midnight of its calendar date. */
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
}

/** Wall-clock date-time as written in the feed, before timezone resolution. */
interface IcsDateTime {
  y: number;
  mo: number; // 1–12
  d: number;
  h: number;
  mi: number;
  s: number;
  dateOnly: boolean;
  /** TZID param value, when present. */
  tzid: string | null;
  /** Trailing Z (already UTC). */
  utc: boolean;
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Rrule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byday: { ord: number | null; day: number }[] | null; // day: 0=SU…6=SA (JS getUTCDay)
  bymonthday: number | null;
  count: number | null;
  untilMs: number | null;
  /** True when the rule carries parts this expander does not implement. */
  unsupported: boolean;
}

interface IcsVevent {
  uid: string;
  title: string;
  location: string | null;
  description: string | null;
  start: IcsDateTime | null;
  end: IcsDateTime | null;
  /** DURATION in ms when DTEND is absent. */
  durationMs: number | null;
  rrule: Rrule | null;
  exdates: IcsDateTime[];
  rdates: IcsDateTime[];
  recurrenceId: IcsDateTime | null;
  cancelled: boolean;
}

const DAY_MS = 86_400_000;
const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// Hard caps so a pathological feed can never spin the poller: per-rule iteration
// bound (day-stepping a WEEKLY rule from a years-old DTSTART) and a cap on
// occurrences one event may contribute.
const MAX_ITERATIONS = 20_000;
const MAX_OCCURRENCES_PER_EVENT = 1_000;

/** Unfold RFC 5545 folded lines (a continuation line starts with space/tab). */
export function unfoldIcsLines(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

/** Unescape an ICS text value (\n, \, \; \\). */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Split one unfolded line into name, params and value. The first ':' outside
 * double quotes separates the prefix from the value; params are ';'-separated
 * (also quote-aware — `TZID="America/New_York"` is legal).
 */
export function parseIcsProperty(line: string): IcsProperty | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const prefix = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const parts: string[] = [];
  let cur = '';
  inQuotes = false;
  for (const ch of prefix) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue; // quotes are delimiters only, drop them from the value
    }
    if (ch === ';' && !inQuotes) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);

  const name = (parts[0] ?? '').trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim();
  }
  return { name, params, value };
}

/** Parse an ICS date / date-time value ("20260830", "20260830T074000", "…Z"). */
function parseIcsDateTime(
  value: string,
  params: Record<string, string>,
): IcsDateTime | null {
  const v = value.trim();
  const dateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(v);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: m[4] ? Number(m[4]) : 0,
    mi: m[5] ? Number(m[5]) : 0,
    s: m[6] ? Number(m[6]) : 0,
    dateOnly,
    tzid: params.TZID ?? null,
    utc: m[7] === 'Z',
  };
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a wall-clock ICS date-time to UTC ms. All-day values become UTC
 * midnight of the date (they carry no zone — callers treat them by DATE).
 * A floating time (no TZID, no Z) or an unknown TZID is read as UTC — Google
 * always exports a zone, so this is a rare-feed fallback, not the common path.
 */
export function icsDateTimeToMs(dt: IcsDateTime): number {
  if (dt.dateOnly) return Date.UTC(dt.y, dt.mo - 1, dt.d);
  if (dt.utc || !dt.tzid || !isValidTz(dt.tzid)) {
    return Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s);
  }
  return zonedTimeToUtcMs(dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s, dt.tzid);
}

/** Parse an RFC 5545 DURATION ("PT1H30M", "P2D") into ms; null when unparseable. */
export function parseIcsDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const [, , w, d, h, mi, s] = m;
  if (!w && !d && !h && !mi && !s) return null;
  return (
    sign *
    ((Number(w ?? 0) * 7 + Number(d ?? 0)) * DAY_MS +
      Number(h ?? 0) * 3_600_000 +
      Number(mi ?? 0) * 60_000 +
      Number(s ?? 0) * 1000)
  );
}

const SUPPORTED_RRULE_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'COUNT',
  'UNTIL',
  'WKST',
  // Google adds BYMONTH to YEARLY rules where it just restates DTSTART's month.
  'BYMONTH',
]);

function parseRrule(value: string): Rrule | null {
  const parts: Record<string, string> = {};
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim();
  }
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    return null;
  }
  let unsupported = Object.keys(parts).some((k) => !SUPPORTED_RRULE_PARTS.has(k));

  let byday: Rrule['byday'] = null;
  if (parts.BYDAY) {
    byday = [];
    for (const tok of parts.BYDAY.split(',')) {
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.trim().toUpperCase());
      if (!m) {
        unsupported = true;
        continue;
      }
      byday.push({ ord: m[1] ? Number(m[1]) : null, day: WEEKDAYS[m[2]!]! });
    }
    if (byday.length === 0) byday = null;
    // Ordinal BYDAY («2TU» — второй вторник) is meaningful for MONTHLY; in a
    // WEEKLY rule ordinals don't exist, and elsewhere we don't implement them.
    if (freq === 'WEEKLY' && byday?.some((b) => b.ord !== null)) unsupported = true;
    if ((freq === 'DAILY' || freq === 'YEARLY') && byday) unsupported = true;
  }

  let untilMs: number | null = null;
  if (parts.UNTIL) {
    const dt = parseIcsDateTime(parts.UNTIL, {});
    // A date-only UNTIL is inclusive of that whole day.
    untilMs = dt ? icsDateTimeToMs(dt) + (dt.dateOnly ? DAY_MS - 1 : 0) : null;
    if (untilMs === null) unsupported = true;
  }

  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    byday,
    bymonthday: parts.BYMONTHDAY ? Number(parts.BYMONTHDAY.split(',')[0]) || null : null,
    count: parts.COUNT ? Number(parts.COUNT) || null : null,
    untilMs,
    unsupported: unsupported || (parts.BYMONTHDAY ?? '').includes(','),
  };
}

/** Parse the feed into raw VEVENTs (no expansion yet). Exported for tests. */
export function parseIcsEvents(text: string): IcsVevent[] {
  const lines = unfoldIcsLines(text);
  const events: IcsVevent[] = [];
  let cur: IcsVevent | null = null;

  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      cur = {
        uid: '',
        title: '(без названия)',
        location: null,
        description: null,
        start: null,
        end: null,
        durationMs: null,
        rrule: null,
        exdates: [],
        rdates: [],
        recurrenceId: null,
        cancelled: false,
      };
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      if (cur && cur.uid && cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parseIcsProperty(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID':
        cur.uid = prop.value.trim();
        break;
      case 'SUMMARY':
        cur.title = unescapeText(prop.value).trim() || '(без названия)';
        break;
      case 'LOCATION': {
        const loc = unescapeText(prop.value).trim();
        cur.location = loc || null;
        break;
      }
      case 'DESCRIPTION': {
        const desc = unescapeText(prop.value).trim();
        cur.description = desc || null;
        break;
      }
      case 'DTSTART':
        cur.start = parseIcsDateTime(prop.value, prop.params);
        break;
      case 'DTEND':
        cur.end = parseIcsDateTime(prop.value, prop.params);
        break;
      case 'DURATION':
        cur.durationMs = parseIcsDuration(prop.value);
        break;
      case 'RRULE':
        cur.rrule = parseRrule(prop.value);
        break;
      case 'EXDATE':
      case 'RDATE':
        for (const v of prop.value.split(',')) {
          const dt = parseIcsDateTime(v, prop.params);
          if (dt) (prop.name === 'EXDATE' ? cur.exdates : cur.rdates).push(dt);
        }
        break;
      case 'RECURRENCE-ID':
        cur.recurrenceId = parseIcsDateTime(prop.value, prop.params);
        break;
      case 'STATUS':
        cur.cancelled = prop.value.trim().toUpperCase() === 'CANCELLED';
        break;
      default:
        break;
    }
  }
  return events;
}

/** Days between two UTC-midnight-aligned date values. */
function daysBetween(aMs: number, bMs: number): number {
  return Math.round((bMs - aMs) / DAY_MS);
}

/**
 * Generate the wall-clock occurrence DATES of a recurrence rule (the time-of-day
 * part is DTSTART's, applied by the caller). Returns UTC-midnight ms of each
 * occurrence's calendar date, ascending, honouring COUNT/UNTIL, bounded by
 * `hardEndMs` on the occurrence date and by the iteration caps.
 */
function ruleOccurrenceDates(
  start: IcsDateTime,
  rule: Rrule,
  hardEndMs: number,
): number[] {
  const out: number[] = [];
  const startDateMs = Date.UTC(start.y, start.mo - 1, start.d);
  const push = (dateMs: number): boolean => {
    out.push(dateMs);
    return out.length < MAX_OCCURRENCES_PER_EVENT && (rule.count === null || out.length < rule.count);
  };

  if (rule.freq === 'DAILY') {
    for (let i = 0, date = startDateMs; i < MAX_ITERATIONS && date <= hardEndMs; i++, date = startDateMs + i * rule.interval * DAY_MS) {
      if (!push(date)) break;
    }
    return out;
  }

  if (rule.freq === 'WEEKLY') {
    const days = rule.byday?.map((b) => b.day) ?? [new Date(startDateMs).getUTCDay()];
    const daySet = new Set(days);
    // Week index counted from the Monday-based week containing DTSTART (WKST
    // defaults to MO; Google keeps that default).
    const startDow = new Date(startDateMs).getUTCDay();
    const weekAnchor = startDateMs - ((startDow + 6) % 7) * DAY_MS;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const date = startDateMs + i * DAY_MS;
      if (date > hardEndMs) break;
      const dow = new Date(date).getUTCDay();
      if (!daySet.has(dow)) continue;
      const week = Math.floor(daysBetween(weekAnchor, date - ((dow + 6) % 7) * DAY_MS) / 7);
      if (week % rule.interval !== 0) continue;
      if (!push(date)) break;
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    const ordDay = rule.byday?.length === 1 && rule.byday[0]!.ord !== null ? rule.byday[0]! : null;
    for (let i = 0; i * rule.interval < MAX_ITERATIONS; i++) {
      const monthIndex = start.mo - 1 + i * rule.interval;
      const y = start.y + Math.floor(monthIndex / 12);
      const mo = monthIndex % 12;
      let date: number | null = null;
      if (ordDay) {
        // «N-й такой-то день месяца» (2TU) or «последний …» (-1FR).
        const firstOfMonth = Date.UTC(y, mo, 1);
        const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        if (ordDay.ord! > 0) {
          const firstDow = new Date(firstOfMonth).getUTCDay();
          const day = 1 + ((ordDay.day - firstDow + 7) % 7) + (ordDay.ord! - 1) * 7;
          date = day <= daysInMonth ? Date.UTC(y, mo, day) : null;
        } else {
          const lastDow = new Date(Date.UTC(y, mo, daysInMonth)).getUTCDay();
          const day = daysInMonth - ((lastDow - ordDay.day + 7) % 7) + (ordDay.ord! + 1) * 7;
          date = day >= 1 ? Date.UTC(y, mo, day) : null;
        }
      } else {
        const dom = rule.bymonthday ?? start.d;
        const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        const day = dom < 0 ? daysInMonth + dom + 1 : dom;
        date = day >= 1 && day <= daysInMonth ? Date.UTC(y, mo, day) : null;
      }
      if (date === null) continue;
      if (date < startDateMs) continue;
      if (date > hardEndMs) break;
      if (!push(date)) break;
    }
    return out;
  }

  // YEARLY
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const y = start.y + i * rule.interval;
    const date = Date.UTC(y, start.mo - 1, start.d);
    if (date > hardEndMs) break;
    // Feb-29 starts only occur on leap years; Date.UTC would roll over to Mar 1.
    if (new Date(date).getUTCDate() !== start.d) continue;
    if (!push(date)) break;
  }
  return out;
}

/**
 * Expand a feed into concrete occurrences within [windowStartMs, windowEndMs).
 * Ongoing events (started before the window but not yet over) are kept.
 */
export function expandIcs(
  text: string,
  windowStartMs: number,
  windowEndMs: number,
): IcsOccurrence[] {
  const events = parseIcsEvents(text);

  // RECURRENCE-ID overrides: a detached VEVENT that replaces ONE occurrence of
  // its master (possibly moved / renamed). Group them by UID first.
  const overridden = new Map<string, Set<number>>();
  for (const ev of events) {
    if (!ev.recurrenceId) continue;
    const set = overridden.get(ev.uid) ?? new Set<number>();
    set.add(icsDateTimeToMs(ev.recurrenceId));
    overridden.set(ev.uid, set);
  }

  const out: IcsOccurrence[] = [];
  const seen = new Set<string>();
  const add = (occ: IcsOccurrence): void => {
    if (occ.startsAt >= windowEndMs) return;
    if ((occ.endsAt ?? occ.startsAt) < windowStartMs) return;
    const key = `${occ.uid} ${occ.startsAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(occ);
  };

  for (const ev of events) {
    if (ev.cancelled || !ev.start) continue;
    const startMs = icsDateTimeToMs(ev.start);
    const allDay = ev.start.dateOnly;
    let durationMs: number | null = null;
    if (ev.end) durationMs = icsDateTimeToMs(ev.end) - startMs;
    else if (ev.durationMs !== null) durationMs = ev.durationMs;
    else if (allDay) durationMs = DAY_MS;
    if (durationMs !== null && durationMs < 0) durationMs = null;
    const base = {
      uid: ev.uid,
      title: ev.title,
      location: ev.location,
      description: ev.description,
      allDay,
    };
    const withStart = (occStartMs: number): IcsOccurrence => ({
      ...base,
      startsAt: occStartMs,
      endsAt: durationMs !== null ? occStartMs + durationMs : null,
    });

    // A detached override stands on its own (its master's matching occurrence is
    // suppressed below via the `overridden` map).
    if (ev.recurrenceId) {
      add(withStart(startMs));
      continue;
    }

    const skip = overridden.get(ev.uid) ?? new Set<number>();
    const exdates = new Set(ev.exdates.map(icsDateTimeToMs));
    const emit = (occStartMs: number): void => {
      if (skip.has(occStartMs) || exdates.has(occStartMs)) return;
      add(withStart(occStartMs));
    };

    if (!ev.rrule || ev.rrule.unsupported) {
      // No rule — a plain event. An UNSUPPORTED rule — never guess dates: the
      // base occurrence and explicit RDATEs are all we can state safely.
      emit(startMs);
    } else {
      const hardEnd = Math.min(
        windowEndMs,
        ev.rrule.untilMs !== null ? ev.rrule.untilMs : Number.MAX_SAFE_INTEGER,
      );
      const dates = ruleOccurrenceDates(ev.start, ev.rrule, hardEnd + DAY_MS);
      for (const dateMs of dates) {
        // Re-resolve the wall-clock time at each occurrence's own date, so a
        // TZID event keeps its local time across DST.
        const d = new Date(dateMs);
        const occStart = icsDateTimeToMs({
          ...ev.start,
          y: d.getUTCFullYear(),
          mo: d.getUTCMonth() + 1,
          d: d.getUTCDate(),
        });
        if (ev.rrule.untilMs !== null && occStart > ev.rrule.untilMs) continue;
        emit(occStart);
      }
    }
    for (const r of ev.rdates) emit(icsDateTimeToMs(r));
  }

  out.sort((a, b) => a.startsAt - b.startsAt || a.uid.localeCompare(b.uid));
  return out;
}

/** Quick sniff that a fetched body is actually an iCalendar feed. */
export function looksLikeIcs(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text.slice(0, 2000));
}

/** The feed's own display name (X-WR-CALNAME), for a default calendar label. */
export function icsCalendarName(text: string): string | null {
  for (const line of unfoldIcsLines(text.slice(0, 20_000))) {
    if (/^BEGIN:VEVENT/i.test(line)) break; // calendar props come before events
    const prop = parseIcsProperty(line);
    if (prop?.name === 'X-WR-CALNAME') {
      const name = unescapeText(prop.value).trim();
      return name || null;
    }
  }
  return null;
}
