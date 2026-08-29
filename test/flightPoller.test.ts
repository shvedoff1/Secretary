import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Bot } from 'grammy';
import type { FlightSnapshot } from '../src/flight/status.js';

// End-to-end flight-watch poller over a real (in-memory) DB with the feed
// mocked. This is where the daemon's discipline lives: baseline silently, fire
// on cancel/reschedule, notify-then-disarm ordering, survive feed failures,
// expire audibly. The mocked `flightFeedConfigured` reads the env at CALL time
// (the real one caches config per module graph, which a hoisted mock outlives),
// so the switch-off tests still exercise the poller's gate.

const fetchMock = vi.fn<(flight: string) => Promise<FlightSnapshot[]>>();
vi.mock('../src/flight/feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/flight/feed.js')>();
  return {
    ...actual,
    fetchFlightStatuses: (flight: string) => fetchMock(flight),
    flightFeedConfigured: () =>
      process.env.ENABLE_FLIGHTS !== 'false' && !!process.env.AVIATIONSTACK_API_KEY,
  };
});

const sendMessage = vi.fn(async () => ({}));
const bot = { api: { sendMessage } } as unknown as Bot;

async function freshModules() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.AVIATIONSTACK_API_KEY = 'test-key';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const poller = await import('../src/flight/poller.js');
  const repo = await import('../src/db/repos/flightWatch.repo.js');
  return { poller, repo };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
  fetchMock.mockReset();
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({});
});
afterEach(() => {
  if (closeDb) closeDb();
  delete process.env.AVIATIONSTACK_API_KEY;
  delete process.env.ENABLE_FLIGHTS;
});

function snap(over: Partial<FlightSnapshot> = {}): FlightSnapshot {
  return {
    flightIata: 'K6829',
    flightDate: '2026-08-30',
    status: 'scheduled',
    airline: 'Cambodia Angkor Air',
    dep: {
      airport: 'Phnom Penh',
      iata: 'PNH',
      scheduled: '2026-08-30T10:00:00+00:00',
      estimated: null,
      actual: null,
      delayMin: null,
      terminal: null,
      gate: null,
      ...(over.dep ?? {}),
    },
    arr: {
      airport: 'Siem Reap',
      iata: 'SAI',
      scheduled: '2026-08-30T11:00:00+00:00',
      estimated: null,
      actual: null,
      delayMin: null,
      terminal: null,
      gate: null,
      ...(over.arr ?? {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'dep' && k !== 'arr')),
  };
}

function armWatch(
  repo: Awaited<ReturnType<typeof freshModules>>['repo'],
  over: Record<string, unknown> = {},
): number {
  return repo.createFlightWatch({
    chatId: 100,
    tgUserId: 1,
    title: 'Рейс в Сиемреап',
    flight: 'K6829',
    flightDate: '2026-08-30',
    intervalMinutes: 60,
    expiresAt: Date.now() + 86_400_000,
    nextCheckAt: 0,
    ...over,
  });
}

describe('runDueFlightWatches', () => {
  it('stores the first data as a silent baseline and reschedules', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo);
    fetchMock.mockResolvedValue([snap()]);

    await poller.runDueFlightWatches(bot);

    expect(sendMessage).not.toHaveBeenCalled();
    const [w] = repo.listFlightWatches(100);
    expect(w!.lastSnapshot).not.toBeNull();
    expect(w!.nextCheckAt).toBeGreaterThan(Date.now());
  });

  it('a flight ALREADY cancelled at the first poll is delivered, not baselined', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo);
    fetchMock.mockResolvedValue([snap({ status: 'cancelled' })]);

    await poller.runDueFlightWatches(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(chatId).toBe(100);
    expect(text).toContain('ОТМЕНЁН');
    expect(text).toContain('K6829');
    expect(repo.listFlightWatches(100)).toEqual([]); // disarmed
  });

  it('notifies and disarms when a watched flight becomes cancelled', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockResolvedValue([snap()]);
    await poller.runDueFlightWatches(bot); // baseline

    fetchMock.mockResolvedValue([snap({ status: 'cancelled' })]);
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toContain('ОТМЕНИЛИ');
    expect(repo.listFlightWatches(100)).toEqual([]);
  });

  it('notifies a reschedule, advances the baseline, and keeps watching', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockResolvedValue([snap()]);
    await poller.runDueFlightWatches(bot); // baseline

    const moved = snap({ dep: { estimated: '2026-08-30T11:30:00+00:00' } as never });
    fetchMock.mockResolvedValue([moved]);
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = String(sendMessage.mock.calls[0]![1]);
    expect(text).toContain('вылет перенесли');
    expect(text).toContain('30.08 10:00 → 30.08 11:30');
    expect(repo.listFlightWatches(100)).toHaveLength(1); // still armed

    // Same data again => baseline advanced, no repeat notification.
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the baseline over silent under-threshold moves so creep still fires', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockResolvedValue([snap()]);
    await poller.runDueFlightWatches(bot); // baseline at 10:00

    fetchMock.mockResolvedValue([snap({ dep: { estimated: '2026-08-30T10:06:00+00:00' } as never })]);
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);
    expect(sendMessage).not.toHaveBeenCalled(); // +6 < 10-min threshold

    fetchMock.mockResolvedValue([snap({ dep: { estimated: '2026-08-30T10:12:00+00:00' } as never })]);
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);
    expect(sendMessage).toHaveBeenCalledTimes(1); // +12 vs the ORIGINAL 10:00 fires
    expect(String(sendMessage.mock.calls[0]![1])).toContain('12 мин');
  });

  it('stays armed if the change notification fails to send (re-announces next poll)', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockResolvedValue([snap()]);
    await poller.runDueFlightWatches(bot); // baseline

    fetchMock.mockResolvedValue([snap({ status: 'cancelled' })]);
    sendMessage.mockRejectedValueOnce(new Error('telegram down'));
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);
    expect(repo.listFlightWatches(100)).toHaveLength(1); // still armed

    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);
    expect(repo.listFlightWatches(100)).toEqual([]); // delivered on the retry
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('a feed that does not cover the watched date yet is silence, not failure', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo, { flightDate: '2026-09-15' });
    fetchMock.mockResolvedValue([snap()]); // only the 30.08 leg exists

    await poller.runDueFlightWatches(bot);

    expect(sendMessage).not.toHaveBeenCalled();
    const [w] = repo.listFlightWatches(100);
    expect(w!.failCount).toBe(0);
    expect(w!.lastSnapshot).toBeNull();
  });

  it('warns on the FIRST auth failure (a dead key must not eat a short watch in silence)', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockRejectedValue(new Error('AeroDataBox HTTP 401: invalid key'));

    await poller.runDueFlightWatches(bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toContain('API-ключом');

    // No nagging on every subsequent poll while the same error persists.
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('counts consecutive feed failures and warns the chat exactly once', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockRejectedValue(new Error('quota exceeded'));

    for (let i = 0; i < 12; i++) {
      repo.forceFlightCheck(id, 100);
      await poller.runDueFlightWatches(bot);
    }

    expect(repo.listFlightWatches(100)[0]!.failCount).toBe(12);
    const warnings = sendMessage.mock.calls.filter(([, text]) =>
      String(text).includes('не могу получить данные'),
    );
    expect(warnings.length).toBe(1);
  });

  it('disarms an expired watch with a farewell note instead of polling it', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo, { expiresAt: Date.now() - 1 });

    await poller.runDueFlightWatches(bot);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(repo.listFlightWatches(100)).toEqual([]);
    expect(String(sendMessage.mock.calls[0]![1])).toContain('время вышло');
  });

  it('notifies and disarms on landing', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockResolvedValue([snap({ status: 'active' })]);
    await poller.runDueFlightWatches(bot); // baseline (in the air)

    fetchMock.mockResolvedValue([
      snap({ status: 'landed', arr: { actual: '2026-08-30T11:02:00+00:00' } as never }),
    ]);
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);

    expect(String(sendMessage.mock.calls[0]![1])).toContain('сел');
    expect(repo.listFlightWatches(100)).toEqual([]);
  });

  it('notifies a gate assignment (the «скоро посадка» proxy) and keeps watching', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockResolvedValue([snap()]);
    await poller.runDueFlightWatches(bot); // baseline, no gate yet

    fetchMock.mockResolvedValue([snap({ dep: { gate: 'B3' } as never })]);
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toContain('назначили гейт B3');
    expect(repo.listFlightWatches(100)).toHaveLength(1); // still armed
  });

  it('notifies when boarding is announced and keeps watching for the takeoff', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockResolvedValue([snap()]);
    await poller.runDueFlightWatches(bot); // baseline

    fetchMock.mockResolvedValue([snap({ status: 'boarding' })]);
    repo.forceFlightCheck(id, 100);
    await poller.runDueFlightWatches(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toContain('посадка');
    expect(repo.listFlightWatches(100)).toHaveLength(1); // still armed
  });

  it('paces adaptively: slow far from departure, tight in the final hour', async () => {
    const { poller, repo } = await freshModules();
    const farId = armWatch(repo, { flightDate: null });
    const nearId = armWatch(repo, { flight: 'SU100', flightDate: null });

    const dep = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();
    fetchMock.mockImplementation(async (flight) => [
      flight === 'K6829'
        ? snap({ dep: { scheduled: dep(48) } as never })
        : snap({ flightIata: 'SU100', dep: { scheduled: dep(0.5) } as never }),
    ]);

    await poller.runDueFlightWatches(bot);

    const far = repo.listFlightWatches(100).find((w) => w.id === farId)!;
    const near = repo.listFlightWatches(100).find((w) => w.id === nearId)!;
    const minutesOut = (w: { nextCheckAt: number }): number =>
      Math.round((w.nextCheckAt - Date.now()) / 60_000);
    expect(minutesOut(far)).toBeGreaterThanOrEqual(170); // ~3h tier
    expect(minutesOut(near)).toBeLessThanOrEqual(16); // ~15-min tier
    expect(minutesOut(near)).toBeGreaterThanOrEqual(10);
  });

  it('does nothing when the feature is switched off', async () => {
    process.env.ENABLE_FLIGHTS = 'false';
    const { poller, repo } = await freshModules();
    armWatch(repo);
    fetchMock.mockResolvedValue([snap({ status: 'cancelled' })]);

    await poller.runDueFlightWatches(bot);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing without an API key (feed unconfigured)', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo);
    delete process.env.AVIATIONSTACK_API_KEY;
    fetchMock.mockResolvedValue([snap({ status: 'cancelled' })]);

    await poller.runDueFlightWatches(bot);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
