import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The calendar_events tool handler + the context-block peek, over a fresh
// in-memory DB. The load-bearing assertion is ISOLATION: a handler built for one
// chat can never surface another chat's events.
async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const repo = await import('../src/db/repos/calendar.repo.js');
  const handler = await import('../src/calendar/handler.js');
  return { repo, handler };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

const TZ = 'Europe/Moscow';
const NOW = Date.now();

function tomorrowEvent(uid: string, title: string) {
  return {
    uid,
    title,
    location: null,
    description: null,
    startsAt: NOW + 20 * 60 * 60 * 1000,
    endsAt: NOW + 21 * 60 * 60 * 1000,
    allDay: false,
    tzid: null as string | null,
  };
}

describe('calendar_events handler', () => {
  it('tells an unconnected chat how to connect', async () => {
    const { handler } = await fresh();
    const run = handler.makeCalendarEventsHandler(1);
    expect(run({ fromDate: null, toDate: null, timezone: TZ })).toContain('/calendar add');
  });

  it('serves only the OWN chat’s events (isolation)', async () => {
    const { repo, handler } = await fresh();
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'a', icsUrl: 'https://x/1.ics' });
    const b = repo.addCalendar({ chatId: 2, tgUserId: null, name: 'b', icsUrl: 'https://x/2.ics' });
    repo.replaceEvents(a, 1, [tomorrowEvent('e1', 'Секрет чата один')]);
    repo.replaceEvents(b, 2, [tomorrowEvent('e2', 'Секрет чата два')]);

    const one = handler.makeCalendarEventsHandler(1)({ fromDate: null, toDate: null, timezone: TZ });
    expect(one).toContain('Секрет чата один');
    expect(one).not.toContain('Секрет чата два');

    const two = handler.makeCalendarEventsHandler(2)({ fromDate: null, toDate: null, timezone: TZ });
    expect(two).toContain('Секрет чата два');
    expect(two).not.toContain('Секрет чата один');

    expect(handler.calendarConnected(1)).toBe(true);
    expect(handler.calendarConnected(3)).toBe(false);
  });

  it('states the horizon limitation instead of a silent empty answer', async () => {
    const { repo, handler } = await fresh();
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'a', icsUrl: 'https://x/1.ics' });
    repo.replaceEvents(a, 1, [tomorrowEvent('e1', 'Событие')]);
    const run = handler.makeCalendarEventsHandler(1);
    const far = new Date(NOW + 40 * 86_400_000).toISOString().slice(0, 10);
    const res = run({ fromDate: far, toDate: far, timezone: TZ });
    expect(res).toContain('Кэш календаря видит только');
  });

  it('renders the context peek in chat-local time, skipping finished events', async () => {
    const { repo, handler } = await fresh();
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'a', icsUrl: 'https://x/1.ics' });
    repo.replaceEvents(a, 1, [
      tomorrowEvent('up', 'Впереди'),
      {
        uid: 'done',
        title: 'Уже прошло',
        location: null,
        description: null,
        startsAt: NOW - 3 * 60 * 60 * 1000,
        endsAt: NOW - 2 * 60 * 60 * 1000,
        allDay: false,
        tzid: null,
      },
    ]);
    const lines = handler.upcomingCalendarLines(1, TZ, 5);
    expect(lines.join('\n')).toContain('Впереди');
    expect(lines.join('\n')).not.toContain('Уже прошло');
  });
});
