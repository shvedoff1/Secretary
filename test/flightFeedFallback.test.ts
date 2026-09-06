import { describe, it, expect, vi } from 'vitest';
import {
  fetchFlightStatuses,
  flightFeedProviders,
  type FlightFeedAdapter,
} from '../src/flight/feed.js';
import { permanentFailureKind } from '../src/flight/poller.js';
import type { FlightSnapshot } from '../src/flight/status.js';
import type { Config } from '../src/config.js';

// The provider CHAIN: a feed that throws hands the request to the next
// configured one; an empty answer does not. Born from watch #2 (EY407): the
// AeroDataBox key was set but its plan had lapsed («HTTP 400: No active
// Subscription found»), and the other configured feeds never got asked.

function cfg(over: Partial<Config> = {}): Config {
  return {
    ENABLE_FLIGHTS: true,
    AERODATABOX_API_KEY: 'adb',
    AEROAPI_KEY: 'aero',
    AVIATIONSTACK_API_KEY: 'avs',
    ...over,
  } as Config;
}

const snap: FlightSnapshot = {
  flightIata: 'EY407',
  flightDate: '2026-09-06',
  status: 'scheduled',
  airline: 'Etihad',
  dep: { airport: 'Bangkok', iata: 'BKK', scheduled: '2026-09-06T21:00+07:00', estimated: null, actual: null, delayMin: null, terminal: null, gate: null },
  arr: { airport: 'Abu Dhabi', iata: 'AUH', scheduled: '2026-09-07T00:30+04:00', estimated: null, actual: null, delayMin: null, terminal: null, gate: null },
};

const dead: FlightFeedAdapter = async () => {
  throw new Error('AeroDataBox HTTP 400: No active Subscription found.');
};

describe('flightFeedProviders', () => {
  it('lists every configured feed in priority order', () => {
    expect(flightFeedProviders(cfg())).toEqual(['aerodatabox', 'aeroapi', 'aviationstack']);
    expect(flightFeedProviders(cfg({ AERODATABOX_API_KEY: undefined }))).toEqual([
      'aeroapi',
      'aviationstack',
    ]);
    expect(flightFeedProviders(cfg({ ENABLE_FLIGHTS: false }))).toEqual([]);
  });
});

describe('fetchFlightStatuses fallback chain', () => {
  it('a failing top provider hands the request to the next one, which stamps its own label', async () => {
    const aeroapi = vi.fn<FlightFeedAdapter>(async () => [snap]);
    const aviationstack = vi.fn<FlightFeedAdapter>(async () => [snap]);
    const out = await fetchFlightStatuses('EY407', '2026-09-06', {
      cfg: cfg(),
      adapters: { aerodatabox: dead, aeroapi, aviationstack },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('FlightAware');
    expect(aeroapi).toHaveBeenCalledWith('EY407', '2026-09-06');
    expect(aviationstack).not.toHaveBeenCalled();
  });

  it('an EMPTY answer is final — no-data-yet must not double the metered calls', async () => {
    const aeroapi = vi.fn<FlightFeedAdapter>(async () => []);
    const aviationstack = vi.fn<FlightFeedAdapter>(async () => [snap]);
    const out = await fetchFlightStatuses('EY407', '2026-09-30', {
      cfg: cfg({ AERODATABOX_API_KEY: undefined }),
      adapters: { aeroapi, aviationstack },
    });
    expect(out).toEqual([]);
    expect(aviationstack).not.toHaveBeenCalled();
  });

  it('when every feed fails the error names each answer, and still reads as an auth failure', async () => {
    const err = await fetchFlightStatuses('EY407', '2026-09-06', {
      cfg: cfg({ AEROAPI_KEY: undefined }),
      adapters: {
        aerodatabox: dead,
        aviationstack: async () => {
          throw new Error('aviationstack error: 104 usage_limit_reached');
        },
      },
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(
      'AeroDataBox: AeroDataBox HTTP 400: No active Subscription found. → aviationstack: aviationstack error: 104 usage_limit_reached',
    );
    expect(permanentFailureKind(err)).toBe('auth');
  });

  it('a lone provider keeps its message verbatim (the poller classifies by it)', async () => {
    const err = await fetchFlightStatuses('EY407', null, {
      cfg: cfg({ AEROAPI_KEY: undefined, AVIATIONSTACK_API_KEY: undefined }),
      adapters: { aerodatabox: dead },
    }).catch((e: unknown) => e as Error);
    expect(err.message).toBe('AeroDataBox HTTP 400: No active Subscription found.');
  });

  it('throws when no provider is configured', async () => {
    await expect(
      fetchFlightStatuses('EY407', null, { cfg: cfg({ ENABLE_FLIGHTS: false }) }),
    ).rejects.toThrow('not configured');
  });
});
