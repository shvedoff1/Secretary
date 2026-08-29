import { describe, it, expect } from 'vitest';
import {
  expandIcs,
  parseIcsEvents,
  parseIcsProperty,
  parseIcsDuration,
  unfoldIcsLines,
  looksLikeIcs,
  icsCalendarName,
} from '../src/calendar/ics.js';

const WIDE_START = Date.UTC(2026, 0, 1);
const WIDE_END = Date.UTC(2027, 0, 1);

function wrap(body: string): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Личный\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

describe('ics building blocks', () => {
  it('unfolds continuation lines', () => {
    const lines = unfoldIcsLines('SUMMARY:Длинное наз\r\n вание\r\nUID:1');
    expect(lines).toEqual(['SUMMARY:Длинное название', 'UID:1']);
  });

  it('parses params (quoted values included) and finds the value colon', () => {
    const p = parseIcsProperty('DTSTART;TZID="America/New_York";VALUE=DATE-TIME:20260830T074000');
    expect(p?.name).toBe('DTSTART');
    expect(p?.params.TZID).toBe('America/New_York');
    expect(p?.value).toBe('20260830T074000');
  });

  it('parses durations', () => {
    expect(parseIcsDuration('PT1H30M')).toBe(90 * 60_000);
    expect(parseIcsDuration('P2D')).toBe(2 * 86_400_000);
    expect(parseIcsDuration('nonsense')).toBeNull();
  });

  it('sniffs feeds and reads the calendar name', () => {
    const feed = wrap('BEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260830T070000Z\r\nEND:VEVENT');
    expect(looksLikeIcs(feed)).toBe(true);
    expect(looksLikeIcs('<html>')).toBe(false);
    expect(icsCalendarName(feed)).toBe('Личный');
  });

  it('unescapes text values and skips cancelled events', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:a',
        'SUMMARY:Обед\\, потом кино\\nвечером',
        'DTSTART:20260830T100000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:b',
        'SUMMARY:Отменено',
        'STATUS:CANCELLED',
        'DTSTART:20260830T110000Z',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const events = parseIcsEvents(feed);
    expect(events).toHaveLength(2);
    expect(events[0]!.title).toBe('Обед, потом кино\nвечером');
    const occ = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ.map((o) => o.uid)).toEqual(['a']);
  });
});

describe('expandIcs', () => {
  it('resolves a TZID wall-clock time to UTC', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:msk',
        'SUMMARY:Самолёт в Москву',
        'LOCATION:Шереметьево',
        'DTSTART;TZID=Europe/Moscow:20260830T074000',
        'DTEND;TZID=Europe/Moscow:20260830T113000',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const [occ] = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ?.startsAt).toBe(Date.UTC(2026, 7, 30, 4, 40)); // 07:40 MSK = 04:40 UTC
    expect(occ?.endsAt).toBe(Date.UTC(2026, 7, 30, 8, 30));
    expect(occ?.allDay).toBe(false);
    expect(occ?.location).toBe('Шереметьево');
  });

  it('treats VALUE=DATE events as all-day at UTC midnight of the date', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:bday',
        'SUMMARY:Днюха Гоши',
        'DTSTART;VALUE=DATE:20260830',
        'DTEND;VALUE=DATE:20260831',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const [occ] = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ?.allDay).toBe(true);
    expect(occ?.startsAt).toBe(Date.UTC(2026, 7, 30));
    expect(occ?.endsAt).toBe(Date.UTC(2026, 7, 31));
  });

  it('expands DAILY with COUNT', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:d',
        'SUMMARY:Таблетка',
        'DTSTART:20260810T060000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const occ = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ.map((o) => o.startsAt)).toEqual([
      Date.UTC(2026, 7, 10, 6),
      Date.UTC(2026, 7, 11, 6),
      Date.UTC(2026, 7, 12, 6),
    ]);
  });

  it('keeps the LOCAL time of a weekly TZID event across a DST switch', () => {
    // Fri Oct 30 2026 10:00 in New York is EDT (UTC-4); the next Friday is
    // after the Nov 1 fall-back, EST (UTC-5) — same 10:00 local, new offset.
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:w',
        'SUMMARY:Созвон',
        'DTSTART;TZID=America/New_York:20261030T100000',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const occ = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ.map((o) => o.startsAt)).toEqual([
      Date.UTC(2026, 9, 30, 14), // EDT
      Date.UTC(2026, 10, 6, 15), // EST
    ]);
  });

  it('expands WEEKLY BYDAY with INTERVAL and honours UNTIL', () => {
    // Mon Aug 3 2026; every 2 weeks on Mon+Wed until Aug 31.
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:g',
        'SUMMARY:Зал',
        'DTSTART:20260803T170000Z',
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20260831T235959Z',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const occ = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ.map((o) => new Date(o.startsAt).toISOString().slice(0, 10))).toEqual([
      '2026-08-03',
      '2026-08-05',
      '2026-08-17',
      '2026-08-19',
      '2026-08-31',
    ]);
  });

  it('expands MONTHLY on an ordinal weekday (второй вторник)', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:m',
        'SUMMARY:Планёрка',
        'DTSTART:20260908T090000Z', // 2nd Tuesday of Sep 2026
        'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const occ = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ.map((o) => new Date(o.startsAt).toISOString().slice(0, 10))).toEqual([
      '2026-09-08',
      '2026-10-13',
      '2026-11-10',
    ]);
  });

  it('drops EXDATE occurrences and applies RECURRENCE-ID overrides', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:r',
        'SUMMARY:Стендап',
        'DTSTART:20260810T080000Z',
        'RRULE:FREQ=DAILY;COUNT=4',
        'EXDATE:20260811T080000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:r',
        'RECURRENCE-ID:20260812T080000Z',
        'SUMMARY:Стендап (перенесён)',
        'DTSTART:20260812T100000Z',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const occ = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ.map((o) => [new Date(o.startsAt).toISOString().slice(0, 13), o.title])).toEqual([
      ['2026-08-10T08', 'Стендап'],
      ['2026-08-12T10', 'Стендап (перенесён)'],
      ['2026-08-13T08', 'Стендап'],
    ]);
  });

  it('never guesses at an unsupported RRULE — base occurrence only', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:u',
        'SUMMARY:Хитрое расписание',
        'DTSTART:20260810T080000Z',
        'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const occ = expandIcs(feed, WIDE_START, WIDE_END);
    expect(occ).toHaveLength(1);
    expect(occ[0]?.startsAt).toBe(Date.UTC(2026, 7, 10, 8));
  });

  it('clips to the window but keeps ongoing events', () => {
    const feed = wrap(
      [
        'BEGIN:VEVENT',
        'UID:long',
        'SUMMARY:Отпуск',
        'DTSTART;VALUE=DATE:20260801',
        'DTEND;VALUE=DATE:20260815',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:past',
        'SUMMARY:Давно прошло',
        'DTSTART:20260701T100000Z',
        'DTEND:20260701T110000Z',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const occ = expandIcs(feed, Date.UTC(2026, 7, 10), Date.UTC(2026, 7, 20));
    expect(occ.map((o) => o.uid)).toEqual(['long']);
  });
});
