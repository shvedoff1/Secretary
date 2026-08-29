import { describe, it, expect } from 'vitest';
import {
  isTravelEvent,
  formatLead,
  planNotices,
  renderNotice,
  type NoticeEvent,
} from '../src/calendar/notice.js';

// REGRESSION: «⏰ Через 60 мин: Flight …» — a flight pinged an hour before
// departure is a missed flight, not a reminder. Travel-shaped events get the
// long lead (CALENDAR_SOON_TRAVEL_MINUTES); ordinary meetings keep the short one.

const TZ = 'Asia/Ho_Chi_Minh';
const START = Date.UTC(2026, 7, 29, 11, 25); // 18:25 ICT

function event(over: Partial<NoticeEvent>): NoticeEvent {
  return {
    uid: 'e',
    title: 'Событие',
    location: null,
    startsAt: START,
    endsAt: null,
    allDay: false,
    ...over,
  };
}

function plan(events: NoticeEvent[], nowMs: number) {
  return planNotices({
    events,
    nowMs,
    tz: TZ,
    eveningHour: 21,
    morningHour: 8,
    earlyHour: 10,
    soonMinutes: 60,
    soonTravelMinutes: 180,
    isSent: () => false,
  }).filter((n) => n.kind === 'soon');
}

describe('isTravelEvent', () => {
  it('spots flights, trains and airports in RU/EN, and bare flight numbers', () => {
    expect(isTravelEvent({ title: 'Flight to Сиемреап (K6 829)', location: 'Хошимин SGN' })).toBe(true);
    expect(isTravelEvent({ title: 'Самолёт в Москву', location: null })).toBe(true);
    expect(isTravelEvent({ title: 'Вылет домой', location: null })).toBe(true);
    expect(isTravelEvent({ title: 'Поезд в Питер', location: 'Ленинградский вокзал' })).toBe(true);
    expect(isTravelEvent({ title: 'SU 100', location: null })).toBe(true);
    expect(isTravelEvent({ title: 'Такси', location: 'аэропорт Таншоннят' })).toBe(true);
    expect(isTravelEvent({ title: 'Стоматолог', location: 'клиника' })).toBe(false);
    expect(isTravelEvent({ title: 'Созвон с командой', location: null })).toBe(false);
  });
});

describe('travel lead', () => {
  const flight = event({ uid: 'k6829', title: 'Flight to Сиемреап (K6 829)', location: 'Хошимин SGN' });
  const dentist = event({ uid: 'dent', title: 'Стоматолог' });

  it('pings a flight ~3 hours out, while a meeting still waits', () => {
    const at170 = plan([flight, dentist], START - 170 * 60_000);
    expect(at170.map((n) => n.kind === 'soon' && n.event.uid)).toEqual(['k6829']);
    expect(at170[0]!.kind === 'soon' && at170[0]!.minutesLeft).toBe(170);
  });

  it('still pings a meeting inside the ordinary window', () => {
    const at50 = plan([dentist], START - 50 * 60_000);
    expect(at50).toHaveLength(1);
  });

  it('one slot per occurrence: the early travel ping is the only ping', () => {
    const sent = new Set<string>();
    const first = planNotices({
      events: [flight],
      nowMs: START - 175 * 60_000,
      tz: TZ,
      eveningHour: 21,
      morningHour: 8,
      earlyHour: 10,
      soonMinutes: 60,
      soonTravelMinutes: 180,
      isSent: (s) => sent.has(s),
    }).filter((n) => n.kind === 'soon');
    for (const n of first) sent.add(n.slot);
    const later = planNotices({
      events: [flight],
      nowMs: START - 55 * 60_000,
      tz: TZ,
      eveningHour: 21,
      morningHour: 8,
      earlyHour: 10,
      soonMinutes: 60,
      soonTravelMinutes: 180,
      isSent: (s) => sent.has(s),
    }).filter((n) => n.kind === 'soon');
    expect(first).toHaveLength(1);
    expect(later).toHaveLength(0);
  });

  it('renders the long lead in hours, not «180 мин»', () => {
    expect(formatLead(50)).toBe('50 мин');
    expect(formatLead(95)).toBe('95 мин');
    expect(formatLead(180)).toBe('3 ч');
    expect(formatLead(160)).toBe('2 ч 40 мин');
    expect(formatLead(125)).toBe('2 ч');
    const [n] = plan([flight], START - 180 * 60_000);
    expect(renderNotice(n!, TZ)).toContain('Через 3 ч');
  });
});
