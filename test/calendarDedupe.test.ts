import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dedupeEvents } from '../src/calendar/dedupe.js';

// A flight that lives in two connected calendars is ONE flight to the reader.
// The digest once read «• 21:00 Flight EY 407 · • 21:00 Flight EY 407» and the
// advice model reasoned about two flights — this is the regression test.

function ev(over: Partial<Parameters<typeof dedupeEvents>[0][number]> = {}) {
  return {
    title: 'Flight EY 407: BKK to AUH',
    location: null as string | null,
    description: null as string | null,
    startsAt: 1_000_000,
    allDay: false,
    ...over,
  };
}

describe('dedupeEvents', () => {
  it('collapses the same title at the same instant, keeping the richer copy', () => {
    const out = dedupeEvents([
      ev({}),
      ev({ title: 'flight  ey 407:  bkk to auh', description: 'Бронь ABC123, место 12A', location: 'BKK' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toContain('ABC123');
    expect(out[0]!.location).toBe('BKK');
  });

  it('keeps first-seen order and distinct events', () => {
    const out = dedupeEvents([ev({ title: 'A' }), ev({ title: 'B' }), ev({ title: 'A' })]);
    expect(out.map((e) => e.title)).toEqual(['A', 'B']);
  });

  it('never merges different instants or a timed event with an all-day one', () => {
    expect(dedupeEvents([ev({}), ev({ startsAt: 2_000_000 })])).toHaveLength(2);
    expect(dedupeEvents([ev({}), ev({ allDay: true })])).toHaveLength(2);
  });
});

async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return await import('../src/db/repos/calendar.repo.js');
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

describe('listEvents dedupes across the chat\'s calendars', () => {
  it('returns one row for a flight cached from two calendars', async () => {
    const repo = await fresh();
    const base = 'https://calendar.google.com/calendar/ical/a%40gmail.com/private-x/basic.ics';
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'личный', icsUrl: base });
    const b = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'рейсы', icsUrl: `${base}2` });
    const row = {
      uid: 'u1',
      title: 'Flight EY 407: BKK to AUH',
      location: null,
      description: null,
      startsAt: 5000,
      endsAt: 9000,
      allDay: false,
      tzid: 'Asia/Bangkok',
    };
    repo.replaceEvents(a, 1, [row]);
    repo.replaceEvents(b, 1, [{ ...row, uid: 'u2', description: 'Терминал: не указан' }]);
    const events = repo.listEvents(1, 0, 10_000);
    expect(events).toHaveLength(1);
    expect(events[0]!.description).toBe('Терминал: не указан');
  });
});
