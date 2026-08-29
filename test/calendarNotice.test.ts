import { describe, it, expect } from 'vitest';
import {
  planNotices,
  renderNotice,
  eventLocalDate,
  type NoticeEvent,
  type NoticePlanArgs,
} from '../src/calendar/notice.js';

const TZ = 'Europe/Moscow'; // UTC+3, no DST — stable expectations

function event(over: Partial<NoticeEvent>): NoticeEvent {
  return {
    uid: 'flight',
    title: 'Самолёт в Москву',
    location: 'Шереметьево',
    // 2026-08-30 07:40 MSK
    startsAt: Date.UTC(2026, 7, 30, 4, 40),
    endsAt: Date.UTC(2026, 7, 30, 8, 30),
    allDay: false,
    ...over,
  };
}

function plan(over: Partial<NoticePlanArgs>): ReturnType<typeof planNotices> {
  return planNotices({
    events: [event({})],
    nowMs: Date.UTC(2026, 7, 29, 18, 30), // 21:30 MSK, Aug 29
    tz: TZ,
    eveningHour: 21,
    morningHour: 8,
    earlyHour: 10,
    soonMinutes: 60,
    isSent: () => false,
    ...over,
  });
}

describe('planNotices', () => {
  it('plans the evening digest for tomorrow once the evening hour is reached', () => {
    const notices = plan({});
    expect(notices).toHaveLength(1);
    const n = notices[0]!;
    expect(n.kind).toBe('evening');
    expect(n.slot).toBe('evening:2026-08-30');
    if (n.kind !== 'soon') {
      expect(n.events.map((e) => e.uid)).toEqual(['flight']);
      expect(n.hasEarly).toBe(true); // 07:40 < 10:00
    }
  });

  it('holds the evening digest before the evening hour', () => {
    expect(plan({ nowMs: Date.UTC(2026, 7, 29, 17, 30) })).toHaveLength(0); // 20:30 MSK
  });

  it('never re-plans a sent slot', () => {
    expect(plan({ isSent: () => true })).toHaveLength(0);
  });

  it('plans the morning digest for today, only for events still ahead', () => {
    const gone = event({ uid: 'gone', startsAt: Date.UTC(2026, 7, 30, 4, 0), endsAt: null });
    const ahead = event({ uid: 'dentist', title: 'Стоматолог', startsAt: Date.UTC(2026, 7, 30, 11, 0), endsAt: null });
    const notices = plan({
      events: [gone, ahead],
      nowMs: Date.UTC(2026, 7, 30, 5, 30), // 08:30 MSK, Aug 30
    });
    expect(notices).toHaveLength(1);
    const n = notices[0]!;
    expect(n.slot).toBe('morning:2026-08-30');
    if (n.kind !== 'soon') expect(n.events.map((e) => e.uid)).toEqual(['dentist']);
  });

  it('does not fire the morning digest in the evening window (late connect)', () => {
    const late = event({ uid: 'party', startsAt: Date.UTC(2026, 7, 29, 20, 0), endsAt: null });
    // 21:30 MSK: the party (23:00 MSK today) must not produce a «сегодня» digest.
    const notices = plan({ events: [late], nowMs: Date.UTC(2026, 7, 29, 18, 30) });
    expect(notices.filter((n) => n.kind === 'morning')).toHaveLength(0);
  });

  it('pings shortly before a timed event, never after it started', () => {
    const soon = plan({
      events: [event({ startsAt: Date.UTC(2026, 7, 29, 19, 20), endsAt: null })],
      nowMs: Date.UTC(2026, 7, 29, 18, 30),
    }).filter((n) => n.kind === 'soon');
    expect(soon).toHaveLength(1);
    expect(soon[0]!.kind === 'soon' && soon[0]!.minutesLeft).toBe(50);
    expect(soon[0]!.slot).toBe(`soon:flight:${Date.UTC(2026, 7, 29, 19, 20)}`);

    // Already started → no ping; too far ahead → no ping.
    expect(
      plan({
        events: [event({ startsAt: Date.UTC(2026, 7, 29, 18, 0), endsAt: null })],
        nowMs: Date.UTC(2026, 7, 29, 18, 30),
      }).filter((n) => n.kind === 'soon'),
    ).toHaveLength(0);
    expect(
      plan({
        events: [event({ startsAt: Date.UTC(2026, 7, 29, 20, 0), endsAt: null })],
        nowMs: Date.UTC(2026, 7, 29, 18, 30),
      }).filter((n) => n.kind === 'soon'),
    ).toHaveLength(0);
  });

  it('handles all-day events by their bare date and never soon-pings them', () => {
    const bday = event({
      uid: 'bday',
      title: 'Днюха Гоши',
      location: null,
      startsAt: Date.UTC(2026, 7, 30),
      endsAt: Date.UTC(2026, 7, 31),
      allDay: true,
    });
    expect(eventLocalDate(bday, TZ)).toBe('2026-08-30');
    const notices = plan({ events: [bday] });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('evening');
    expect(notices.filter((n) => n.kind === 'soon')).toHaveLength(0);
  });
});

describe('renderNotice', () => {
  it('renders the evening digest deterministically in chat-local time', () => {
    const [n] = plan({});
    const text = renderNotice(n!, TZ);
    expect(text).toContain('Завтра');
    expect(text).toContain('07:40 Самолёт в Москву — Шереметьево');
  });

  it('renders the soon ping with minutes left and local time', () => {
    const [n] = plan({
      events: [event({ startsAt: Date.UTC(2026, 7, 29, 19, 20), endsAt: null })],
      nowMs: Date.UTC(2026, 7, 29, 18, 30),
    }).filter((x) => x.kind === 'soon');
    const text = renderNotice(n!, TZ);
    expect(text).toContain('Через 50 мин');
    expect(text).toContain('«Самолёт в Москву»');
    expect(text).toContain('22:20'); // 19:20 UTC = 22:20 MSK
  });

  it('renders all-day events as «весь день»', () => {
    const bday = event({
      uid: 'bday',
      title: 'Днюха Гоши',
      location: null,
      startsAt: Date.UTC(2026, 7, 30),
      endsAt: Date.UTC(2026, 7, 31),
      allDay: true,
    });
    const [n] = plan({ events: [bday] });
    expect(renderNotice(n!, TZ)).toContain('весь день Днюха Гоши');
  });
});
