import { describe, it, expect } from 'vitest';
import { noticeDetails } from '../src/calendar/reminders.js';
import type { NoticeEvent } from '../src/calendar/notice.js';

const TZ = 'Europe/Moscow';

function event(over: Partial<NoticeEvent>): NoticeEvent {
  return {
    uid: 'flight',
    title: 'Flight to Сиемреап (K6 829)',
    location: 'Хошимин SGN',
    description: 'Терминал 2, место 12A\nБронь: ABC123',
    startsAt: Date.UTC(2026, 7, 29, 8, 25),
    endsAt: null,
    allDay: false,
    ...over,
  };
}

describe('noticeDetails (advice-model context)', () => {
  it('carries the booking description the digest never shows', () => {
    const details = noticeDetails([event({})], TZ);
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('Терминал 2');
    expect(details[0]).toContain('Бронь: ABC123');
    expect(details[0]).toContain('Flight to Сиемреап');
  });

  it('flattens newlines and truncates a fare-rules essay', () => {
    const details = noticeDetails([event({ description: `Терминал 2\n${'правила тарифа '.repeat(60)}` })], TZ);
    expect(details[0]).not.toContain('\n');
    expect(details[0]!.length).toBeLessThan(520);
    expect(details[0]).toContain('…');
  });

  it('skips events with nothing beyond the digest line', () => {
    expect(noticeDetails([event({ description: null }), event({ description: '  ' })], TZ)).toEqual(
      [],
    );
  });
});
