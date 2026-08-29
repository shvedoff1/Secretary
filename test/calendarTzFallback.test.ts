import { describe, it, expect } from 'vitest';
import {
  planNotices,
  renderNotice,
  renderEventLine,
  eventDisplayTz,
  TZ_UNSET_FOOTNOTE,
  type NoticeEvent,
} from '../src/calendar/notice.js';
import { renderEventsForModel } from '../src/calendar/handler.js';
import { expandIcs } from '../src/calendar/ics.js';
import type { CalendarEvent } from '../src/db/repos/calendar.repo.js';

// REGRESSION: рейс K6 829 хранится как 18:25 Asia/Ho_Chi_Minh = 11:25 UTC. Пока
// у чата не задан часовой пояс, рендер в UTC показывал «11:25» — и бот
// «находил» расхождение с авиафидом (18:25), которого не существует. Пока зона
// чата неизвестна, каждое событие рендерится в его СОБСТВЕННОЙ зоне из
// календаря — времени «как на билете».

const SAIGON = 'Asia/Ho_Chi_Minh';
// 18:25 ICT (UTC+7) on Aug 29 2026 = 11:25 UTC.
const FLIGHT_START = Date.UTC(2026, 7, 29, 11, 25);

function flight(over: Partial<NoticeEvent> = {}): NoticeEvent {
  return {
    uid: 'k6829',
    title: 'Flight to Сиемреап (K6 829)',
    location: 'Хошимин SGN',
    startsAt: FLIGHT_START,
    endsAt: null,
    allDay: false,
    tzid: SAIGON,
    ...over,
  };
}

describe('tz fallback: unset chat tz renders the event in ITS OWN zone', () => {
  it('eventDisplayTz picks the event zone only while the chat tz is unknown', () => {
    expect(eventDisplayTz(flight(), 'UTC', false)).toBe(SAIGON);
    expect(eventDisplayTz(flight(), 'Europe/Moscow', true)).toBe('Europe/Moscow');
    expect(eventDisplayTz(flight({ tzid: null }), 'UTC', false)).toBe('UTC');
  });

  it('the K6829 digest shows 18:25 (ticket time), not 11:25 (UTC), with the footnote', () => {
    const notices = planNotices({
      events: [flight()],
      // 21:30 UTC on Aug 28 — the evening digest for Aug 29 in the default (UTC) clock.
      nowMs: Date.UTC(2026, 7, 28, 21, 30),
      tz: 'UTC',
      tzKnown: false,
      eveningHour: 21,
      morningHour: 8,
      earlyHour: 10,
      soonMinutes: 60,
      isSent: () => false,
    });
    expect(notices).toHaveLength(1);
    const text = renderNotice(notices[0]!, 'UTC', false);
    expect(text).toContain('18:25 Flight to Сиемреап');
    expect(text).not.toContain('11:25');
    expect(text).toContain(TZ_UNSET_FOOTNOTE);
  });

  it('once the chat tz is set, rendering is chat-local again (no footnote)', () => {
    const line = renderEventLine(flight(), SAIGON, true);
    expect(line).toContain('18:25');
    const notices = planNotices({
      events: [flight()],
      nowMs: Date.UTC(2026, 7, 28, 15, 0), // 22:00 ICT — evening in Saigon
      tz: SAIGON,
      eveningHour: 21,
      morningHour: 8,
      earlyHour: 10,
      soonMinutes: 60,
      isSent: () => false,
    });
    const text = renderNotice(notices[0]!, SAIGON);
    expect(text).toContain('18:25');
    expect(text).not.toContain(TZ_UNSET_FOOTNOTE);
  });

  it('the soon ping names the zone while the chat tz is unset', () => {
    const notices = planNotices({
      events: [flight()],
      nowMs: FLIGHT_START - 40 * 60_000,
      tz: 'UTC',
      tzKnown: false,
      eveningHour: 21,
      morningHour: 8,
      earlyHour: 10,
      soonMinutes: 60,
      isSent: () => false,
    }).filter((n) => n.kind === 'soon');
    const text = renderNotice(notices[0]!, 'UTC', false);
    expect(text).toContain('18:25');
    expect(text).toContain(SAIGON);
  });

  it('the calendar_events tool output warns the model and tags per-event zones', () => {
    const e: CalendarEvent = { id: 1, calendarId: 1, chatId: 1, description: null, ...flight() } as CalendarEvent;
    const text = renderEventsForModel([e], 'UTC', {
      periodLabel: '2026-08-29',
      horizonNote: null,
      tzKnown: false,
    });
    expect(text).toContain('ЧАСОВОЙ ПОЯС ЧАТА НЕ ЗАДАН');
    expect(text).toContain('18:25');
    expect(text).toContain(`[${SAIGON}]`);
    expect(text).not.toContain('11:25');
  });

  it('the parser keeps the DTSTART zone on every expanded occurrence', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tzd',
      'SUMMARY:Созвон',
      'DTSTART;TZID=Asia/Ho_Chi_Minh:20260829T182500',
      'RRULE:FREQ=DAILY;COUNT=2',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:utc',
      'SUMMARY:УТС',
      'DTSTART:20260829T112500Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:day',
      'SUMMARY:Днюха',
      'DTSTART;VALUE=DATE:20260829',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const occ = expandIcs(feed, Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1));
    const byUid = new Map(occ.map((o) => [`${o.uid}:${o.startsAt}`, o.tzid]));
    expect(byUid.get(`tzd:${FLIGHT_START}`)).toBe(SAIGON);
    expect(byUid.get(`tzd:${Date.UTC(2026, 7, 30, 11, 25)}`)).toBe(SAIGON);
    expect(byUid.get(`utc:${FLIGHT_START}`)).toBeNull();
    expect(byUid.get(`day:${Date.UTC(2026, 7, 29)}`)).toBeNull();
  });
});
