import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WatchFlightInput } from '../src/llm/schema.js';
import type { FlightSnapshot } from '../src/flight/status.js';

// The two flight tool handlers: watch_flight (validation, dedupe, cap, lifetime)
// and flight_status (feed → text card, with every miss stated explicitly).

const fetchMock = vi.fn<() => Promise<FlightSnapshot[]>>();
vi.mock('../src/flight/feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/flight/feed.js')>();
  return { ...actual, fetchFlightStatuses: () => fetchMock() };
});

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const assist = await import('../src/bot/flows/assist.js');
  const repo = await import('../src/db/repos/flightWatch.repo.js');
  const handler = await import('../src/flight/handler.js');
  return { assist, repo, handler };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
  fetchMock.mockReset();
});
afterEach(() => {
  if (closeDb) closeDb();
});

function input(over: Partial<WatchFlightInput> = {}): WatchFlightInput {
  return {
    title: 'Рейс в Сиемреап',
    flight: 'K6 829',
    date: '2030-08-30',
    ...over,
  };
}

function snap(over: Partial<FlightSnapshot> = {}): FlightSnapshot {
  return {
    flightIata: 'K6829',
    flightDate: '2030-08-30',
    status: 'scheduled',
    airline: 'Cambodia Angkor Air',
    dep: {
      airport: 'Phnom Penh',
      iata: 'PNH',
      scheduled: '2030-08-30T10:00:00+00:00',
      estimated: null,
      actual: null,
      delayMin: null,
      terminal: null,
      gate: null,
    },
    arr: {
      airport: 'Siem Reap',
      iata: 'SAI',
      scheduled: '2030-08-30T11:00:00+00:00',
      estimated: null,
      actual: null,
      delayMin: null,
      terminal: null,
      gate: null,
    },
    ...over,
  };
}

describe('makeWatchFlightHandler', () => {
  it('arms a watch due immediately, normalizing the flight number', async () => {
    const { assist, repo } = await load();
    const out = assist.makeWatchFlightHandler(1, 42)(input());

    const [w] = repo.listFlightWatches(1);
    expect(w).toBeDefined();
    expect(w!.flight).toBe('K6829'); // «K6 829» normalized
    expect(w!.flightDate).toBe('2030-08-30');
    expect(w!.nextCheckAt).toBeLessThanOrEqual(Date.now()); // first poll on next tick
    expect(w!.intervalMinutes).toBe(60); // FLIGHT_WATCH_INTERVAL_MINUTES default
    // Dated watch lives until two days past its date.
    expect(w!.expiresAt).toBe(Date.parse('2030-08-30T00:00:00Z') + 2 * 24 * 3600_000);
    expect(out).toContain('K6829');
    expect(out).toContain('/flight');
  });

  it('rejects text that is not a flight number', async () => {
    const { assist, repo } = await load();
    const out = assist.makeWatchFlightHandler(1, 42)(input({ flight: 'завтрашний' }));
    expect(out).toContain('Не похоже на номер рейса');
    expect(repo.listFlightWatches(1)).toEqual([]);
  });

  it('refuses a flight date already in the past', async () => {
    const { assist, repo } = await load();
    const out = assist.makeWatchFlightHandler(1, 42)(input({ date: '2020-01-01' }));
    expect(out).toContain('уже в прошлом');
    expect(repo.listFlightWatches(1)).toEqual([]);
  });

  it('does not re-arm a duplicate watch on the same flight', async () => {
    const { assist } = await load();
    const handler = assist.makeWatchFlightHandler(1, 42);
    handler(input());
    const out = handler(input({ title: 'Другое название' }));
    expect(out).toContain('Уже слежу');
  });

  it('caps active watches per chat', async () => {
    const { assist } = await load();
    const handler = assist.makeWatchFlightHandler(1, 42);
    for (let i = 0; i < 4; i++) {
      // Different flights so the dedupe guard doesn't kick in first.
      handler(input({ flight: `K6 82${i}`, date: null }));
    }
    const out = handler(input({ flight: 'SU 100', date: null }));
    expect(out).toContain('потолок');
  });
});

describe('makeFlightStatusHandler', () => {
  it('returns the card for the asked date', async () => {
    const { handler } = await load();
    fetchMock.mockResolvedValue([snap()]);
    const out = await handler.makeFlightStatusHandler()({
      flight: 'k6-829',
      date: '2030-08-30',
    });
    expect(out).toContain('K6829');
    expect(out).toContain('по расписанию');
    expect(out).toContain('PNH');
  });

  it('states plainly when the asked date has no data yet, showing the nearest leg', async () => {
    const { handler } = await load();
    fetchMock.mockResolvedValue([snap()]);
    const out = await handler.makeFlightStatusHandler()({
      flight: 'K6829',
      date: '2030-09-15',
    });
    expect(out).toContain('пока нет');
    expect(out).toContain('2030-08-30'); // the nearest leg it DOES see
  });

  it('reports a bad flight number without calling the feed', async () => {
    const { handler } = await load();
    const out = await handler.makeFlightStatusHandler()({ flight: '829', date: null });
    expect(out).toContain('Не похоже на номер рейса');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the feed errors or is empty', async () => {
    const { handler } = await load();
    fetchMock.mockRejectedValueOnce(new Error('quota'));
    const failed = await handler.makeFlightStatusHandler()({ flight: 'K6829', date: null });
    expect(failed).toContain('недоступен');

    fetchMock.mockResolvedValueOnce([]);
    const empty = await handler.makeFlightStatusHandler()({ flight: 'K6829', date: null });
    expect(empty).toContain('данных не нашёл');
  });
});
