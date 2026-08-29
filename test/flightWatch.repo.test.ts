import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FlightSnapshot } from '../src/flight/status.js';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/flightWatch.repo.js');
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

function args(over: Record<string, unknown> = {}) {
  return {
    chatId: 100,
    tgUserId: 1,
    title: 'Рейс в Сиемреап',
    flight: 'K6829',
    flightDate: '2026-08-30' as string | null,
    intervalMinutes: 60,
    expiresAt: Date.now() + 86_400_000,
    nextCheckAt: 0,
    ...over,
  };
}

const snapshot: FlightSnapshot = {
  flightIata: 'K6829',
  flightDate: '2026-08-30',
  status: 'scheduled',
  airline: null,
  dep: {
    airport: null,
    iata: 'PNH',
    scheduled: '2026-08-30T10:00:00+00:00',
    estimated: null,
    actual: null,
    delayMin: null,
    terminal: null,
    gate: null,
  },
  arr: {
    airport: null,
    iata: 'SAI',
    scheduled: '2026-08-30T11:00:00+00:00',
    estimated: null,
    actual: null,
    delayMin: null,
    terminal: null,
    gate: null,
  },
};

describe('flightWatch repo', () => {
  it('creates, lists and scopes watches per chat', async () => {
    const repo = await freshRepo();
    const id = repo.createFlightWatch(args());
    repo.createFlightWatch(args({ chatId: 200, flight: 'SU100' }));

    const mine = repo.listFlightWatches(100);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(id);
    expect(mine[0]!.flight).toBe('K6829');
    expect(mine[0]!.flightDate).toBe('2026-08-30');
    expect(mine[0]!.lastSnapshot).toBeNull();
  });

  it('dueFlightWatches returns only enabled watches whose next check has come', async () => {
    const repo = await freshRepo();
    repo.createFlightWatch(args({ nextCheckAt: 0 }));
    repo.createFlightWatch(args({ flight: 'SU100', nextCheckAt: Date.now() + 3_600_000 }));
    const disarmed = repo.createFlightWatch(args({ flight: 'U6263', nextCheckAt: 0 }));
    repo.disableFlightWatch(disarmed);

    const due = repo.dueFlightWatches(Date.now());
    expect(due.map((w) => w.flight)).toEqual(['K6829']);
  });

  it('round-trips the baseline snapshot through setFlightCheckResult', async () => {
    const repo = await freshRepo();
    const id = repo.createFlightWatch(args());
    repo.setFlightCheckResult(id, {
      nextCheckAt: Date.now() + 60_000,
      lastCheckedAt: Date.now(),
      lastSnapshot: snapshot,
      failCount: 0,
    });
    const [w] = repo.listFlightWatches(100);
    expect(w!.lastSnapshot).toEqual(snapshot);
    expect(w!.failCount).toBe(0);
  });

  it('delete and forceCheck are scoped to the chat', async () => {
    const repo = await freshRepo();
    const id = repo.createFlightWatch(args());
    expect(repo.deleteFlightWatch(id, 999)).toBe(false);
    expect(repo.forceFlightCheck(id, 999)).toBe(false);
    expect(repo.forceFlightCheck(id, 100)).toBe(true);
    expect(repo.deleteFlightWatch(id, 100)).toBe(true);
    expect(repo.listFlightWatches(100)).toEqual([]);
  });

  it('findDuplicateFlightWatch conflates same-flight watches when either side is undated', async () => {
    const repo = await freshRepo();
    repo.createFlightWatch(args());
    const active = repo.listFlightWatches(100);

    // Same flight + same date, and an undated candidate on the same flight.
    expect(
      repo.findDuplicateFlightWatch(active, { flight: 'K6829', flightDate: '2026-08-30' }),
    ).toBeDefined();
    expect(
      repo.findDuplicateFlightWatch(active, { flight: 'K6829', flightDate: null }),
    ).toBeDefined();
    // A different date on the same flight is a genuinely different watch...
    expect(
      repo.findDuplicateFlightWatch(active, { flight: 'K6829', flightDate: '2026-09-05' }),
    ).toBeUndefined();
    // ...and another flight never collides.
    expect(
      repo.findDuplicateFlightWatch(active, { flight: 'SU100', flightDate: '2026-08-30' }),
    ).toBeUndefined();
  });
});
