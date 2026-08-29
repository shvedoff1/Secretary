import { describe, it, expect } from 'vitest';
import {
  normalizeFlightNumber,
  pickSnapshot,
  diffSnapshots,
  describeChanges,
  isTerminalChange,
  renderFlightCard,
  wallClock,
  type FlightSnapshot,
  type FlightPoint,
} from '../src/flight/status.js';
import { parseFeedItem } from '../src/flight/feed.js';
import { SYSTEM_PROMPT, buildContextBlock } from '../src/llm/prompts.js';

function point(over: Partial<FlightPoint> = {}): FlightPoint {
  return {
    airport: 'Phnom Penh International',
    iata: 'PNH',
    scheduled: '2026-08-30T10:00:00+00:00',
    estimated: null,
    actual: null,
    delayMin: null,
    terminal: null,
    gate: null,
    ...over,
  };
}

function snap(over: Partial<FlightSnapshot> = {}): FlightSnapshot {
  return {
    flightIata: 'K6829',
    flightDate: '2026-08-30',
    status: 'scheduled',
    airline: 'Cambodia Angkor Air',
    dep: point(),
    arr: point({
      airport: 'Siem Reap',
      iata: 'SAI',
      scheduled: '2026-08-30T11:00:00+00:00',
    }),
    ...over,
  };
}

describe('normalizeFlightNumber', () => {
  it('accepts the common spellings and normalizes to compact IATA', () => {
    expect(normalizeFlightNumber('K6829')).toBe('K6829');
    expect(normalizeFlightNumber('k6 829')).toBe('K6829');
    expect(normalizeFlightNumber('K6-829')).toBe('K6829');
    expect(normalizeFlightNumber('SU 100')).toBe('SU100');
    expect(normalizeFlightNumber('u6-263')).toBe('U6263');
    expect(normalizeFlightNumber('7R 123')).toBe('7R123'); // digit-first designator
    expect(normalizeFlightNumber('BA2490A')).toBe('BA2490A'); // operational suffix
  });

  it('rejects text that cannot be a flight number', () => {
    expect(normalizeFlightNumber('829')).toBeNull(); // no airline code
    expect(normalizeFlightNumber('рейс')).toBeNull();
    expect(normalizeFlightNumber('K6')).toBeNull(); // no number
    expect(normalizeFlightNumber('ABC12345')).toBeNull(); // 3-letter code + 5 digits
  });
});

describe('pickSnapshot', () => {
  const now = Date.parse('2026-08-29T12:00:00Z');

  it('an asked date matches exactly or not at all (feed publishes near the day)', () => {
    const s = [snap({ flightDate: '2026-08-29' }), snap({ flightDate: '2026-08-30' })];
    expect(pickSnapshot(s, '2026-08-30', now)!.flightDate).toBe('2026-08-30');
    expect(pickSnapshot(s, '2026-09-05', now)).toBeNull();
  });

  it('with no date prefers the nearest current/upcoming leg over past ones', () => {
    const past = snap({
      flightDate: '2026-08-28',
      dep: point({ scheduled: '2026-08-28T10:00:00+00:00' }),
    });
    const today = snap({
      flightDate: '2026-08-29',
      dep: point({ scheduled: '2026-08-29T15:00:00+00:00' }),
    });
    const tomorrow = snap({
      flightDate: '2026-08-30',
      dep: point({ scheduled: '2026-08-30T10:00:00+00:00' }),
    });
    expect(pickSnapshot([past, tomorrow, today], null, now)!.flightDate).toBe('2026-08-29');
  });

  it('falls back to the most recent past leg when nothing is upcoming', () => {
    const a = snap({
      flightDate: '2026-08-27',
      dep: point({ scheduled: '2026-08-27T10:00:00+00:00' }),
    });
    const b = snap({
      flightDate: '2026-08-28',
      dep: point({ scheduled: '2026-08-28T10:00:00+00:00' }),
    });
    expect(pickSnapshot([a, b], null, now)!.flightDate).toBe('2026-08-28');
  });
});

describe('diffSnapshots', () => {
  it('reports a cancellation (and drops now-moot time changes alongside it)', () => {
    const prev = snap();
    const next = snap({
      status: 'cancelled',
      dep: point({ estimated: '2026-08-30T12:00:00+00:00' }),
    });
    const changes = diffSnapshots(prev, next, 10);
    expect(changes).toEqual([{ kind: 'cancelled' }]);
    expect(changes.every(isTerminalChange)).toBe(true);
  });

  it('reports a departure move at/over the threshold and stays quiet under it', () => {
    const prev = snap();
    const moved = snap({ dep: point({ estimated: '2026-08-30T10:25:00+00:00' }) });
    const changes = diffSnapshots(prev, moved, 10);
    expect(changes).toEqual([
      {
        kind: 'depTimeChanged',
        from: '2026-08-30T10:00:00+00:00',
        to: '2026-08-30T10:25:00+00:00',
        deltaMin: 25,
      },
    ]);
    const jitter = snap({ dep: point({ estimated: '2026-08-30T10:05:00+00:00' }) });
    expect(diffSnapshots(prev, jitter, 10)).toEqual([]);
  });

  it('a feed that drops a time field is not a reschedule', () => {
    const prev = snap({ dep: point({ estimated: '2026-08-30T10:30:00+00:00' }) });
    const next = snap({ dep: point({ scheduled: null, estimated: null }) });
    expect(diffSnapshots(prev, next, 10)).toEqual([]);
  });

  it('reports takeoff and landing as status transitions', () => {
    const dep = diffSnapshots(
      snap(),
      snap({ status: 'active', dep: point({ actual: '2026-08-30T10:07:00+00:00' }) }),
      10,
    );
    expect(dep[0]).toEqual({ kind: 'departed', at: '2026-08-30T10:07:00+00:00' });
    expect(isTerminalChange(dep[0]!)).toBe(false); // keep watching until it lands

    const land = diffSnapshots(
      snap({ status: 'active' }),
      snap({
        status: 'landed',
        arr: point({ iata: 'SAI', actual: '2026-08-30T11:02:00+00:00' }),
      }),
      10,
    );
    expect(land[0]!.kind).toBe('landed');
    expect(isTerminalChange(land[0]!)).toBe(true);
  });

  it('small under-threshold moves accumulate against the baseline until they cross it', () => {
    const baseline = snap();
    const creep1 = snap({ dep: point({ estimated: '2026-08-30T10:06:00+00:00' }) });
    expect(diffSnapshots(baseline, creep1, 10)).toEqual([]);
    // The poller keeps the OLD baseline after a silent poll, so the next diff is
    // still measured from 10:00 — the +12 total fires even though each step was +6.
    const creep2 = snap({ dep: point({ estimated: '2026-08-30T10:12:00+00:00' }) });
    expect(diffSnapshots(baseline, creep2, 10)).toHaveLength(1);
  });
});

describe('rendering', () => {
  it('wallClock reads the wall time straight off the ISO string (no tz math)', () => {
    expect(wallClock('2026-08-30T10:00:00+00:00')).toBe('30.08 10:00');
    expect(wallClock('2026-08-30T10:00:00+07:00')).toBe('30.08 10:00');
    expect(wallClock(null)).toBeNull();
    expect(wallClock('не время')).toBeNull();
  });

  it('renders a card with flight, status, both airports and the local-time note', () => {
    const card = renderFlightCard(
      snap({ dep: point({ estimated: '2026-08-30T10:25:00+00:00', delayMin: 25 }) }),
    );
    expect(card).toContain('K6829');
    expect(card).toContain('Cambodia Angkor Air');
    expect(card).toContain('по расписанию');
    expect(card).toContain('PNH');
    expect(card).toContain('SAI');
    expect(card).toContain('ожидается 30.08 10:25');
    expect(card).toContain('задержка 25 мин');
    expect(card).toContain('время местное');
  });

  it('describes each change kind in Russian with the times', () => {
    const lines = describeChanges([
      { kind: 'cancelled' },
      {
        kind: 'depTimeChanged',
        from: '2026-08-30T10:00:00+00:00',
        to: '2026-08-30T11:30:00+00:00',
        deltaMin: 90,
      },
      { kind: 'landed', at: '2026-08-30T11:02:00+00:00' },
    ]);
    expect(lines[0]).toContain('ОТМЕНИЛИ');
    expect(lines[1]).toContain('30.08 10:00 → 30.08 11:30');
    expect(lines[1]).toContain('90 мин позже');
    expect(lines[2]).toContain('11:02');
  });
});

describe('parseFeedItem', () => {
  it('normalizes an aviationstack item defensively', () => {
    const parsed = parseFeedItem({
      flight_date: '2026-08-30',
      flight_status: 'Scheduled',
      airline: { name: 'Cambodia Angkor Air' },
      flight: { iata: 'k6829' },
      departure: { airport: 'Phnom Penh', iata: 'PNH', scheduled: '2026-08-30T10:00:00+00:00', delay: 5 },
      arrival: { airport: 'Siem Reap', iata: 'SAI' },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.flightIata).toBe('K6829');
    expect(parsed!.status).toBe('scheduled');
    expect(parsed!.dep.delayMin).toBe(5);
    expect(parsed!.arr.scheduled).toBeNull();
  });

  it('drops garbage items instead of throwing', () => {
    expect(parseFeedItem(null)).toBeNull();
    expect(parseFeedItem('x')).toBeNull();
    expect(parseFeedItem({ flight: {} })).toBeNull();
  });
});

describe('prompt wiring', () => {
  it('the system prompt routes flight numbers to the flight tools', () => {
    expect(SYSTEM_PROMPT).toContain('flight_status');
    expect(SYSTEM_PROMPT).toContain('watch_flight');
    expect(SYSTEM_PROMPT).toContain('Active flight watches');
  });

  it('the context block lists active flight watches so the model never re-arms one', () => {
    const block = buildContextBlock({
      defaultCurrency: 'EUR',
      members: [],
      senderName: 'Андрей',
      timezone: 'Asia/Phnom_Penh',
      splidConnected: false,
      activeFlightWatches: [
        { id: 3, flight: 'K6829', date: '2026-08-30', title: 'Рейс в Сиемреап' },
      ],
    });
    expect(block).toContain('Active flight watches: #3 K6829 (2026-08-30) «Рейс в Сиемреап»');
  });
});
