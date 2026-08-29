import { describe, it, expect } from 'vitest';
import { utcToAirportLocal, parseAeroApiFlight } from '../src/flight/aeroapi.js';
import { flightFeedProvider } from '../src/flight/feed.js';
import type { Config } from '../src/config.js';

// AeroAPI adapter: the contract is that a snapshot leaving it is
// indistinguishable from an aviationstack one — airport-LOCAL ISO times, the
// same status vocabulary — so the differ/renderer never know which feed ran.

describe('utcToAirportLocal', () => {
  it('re-expresses a UTC instant in the airport zone, keeping the absolute time', () => {
    const local = utcToAirportLocal('2026-08-30T03:00:00Z', 'Asia/Phnom_Penh');
    expect(local).toBe('2026-08-30T10:00:00+07:00');
    expect(Date.parse(local!)).toBe(Date.parse('2026-08-30T03:00:00Z'));
  });

  it('handles half-hour zones and a legacy ":Zone" prefix', () => {
    expect(utcToAirportLocal('2026-08-30T03:00:00Z', 'Asia/Kolkata')).toBe(
      '2026-08-30T08:30:00+05:30',
    );
    expect(utcToAirportLocal('2026-08-30T03:00:00Z', ':Asia/Phnom_Penh')).toBe(
      '2026-08-30T10:00:00+07:00',
    );
  });

  it('falls back sanely on missing/bad inputs', () => {
    expect(utcToAirportLocal(null, 'Asia/Phnom_Penh')).toBeNull();
    expect(utcToAirportLocal('не время', 'Asia/Phnom_Penh')).toBeNull();
    // No zone => the UTC string passes through (still consistent for diffing).
    expect(utcToAirportLocal('2026-08-30T03:00:00Z', null)).toBe('2026-08-30T03:00:00Z');
    expect(utcToAirportLocal('2026-08-30T03:00:00Z', 'Not/AZone')).toBe(
      '2026-08-30T03:00:00Z',
    );
  });
});

function fixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ident: 'KHV829',
    ident_iata: 'K6829',
    operator: 'KHV',
    operator_iata: 'K6',
    cancelled: false,
    diverted: false,
    origin: {
      code: 'VDPP',
      code_iata: 'PNH',
      name: 'Phnom Penh Intl',
      timezone: 'Asia/Phnom_Penh',
    },
    destination: {
      code: 'VDSA',
      code_iata: 'SAI',
      name: 'Siem Reap-Angkor Intl',
      timezone: 'Asia/Phnom_Penh',
    },
    scheduled_out: '2026-08-30T03:00:00Z',
    estimated_out: '2026-08-30T03:25:00Z',
    actual_out: null,
    scheduled_in: '2026-08-30T04:00:00Z',
    estimated_in: '2026-08-30T04:20:00Z',
    actual_in: null,
    departure_delay: 1500,
    arrival_delay: 1200,
    gate_origin: 'B3',
    terminal_origin: 'M',
    gate_destination: null,
    terminal_destination: null,
    ...over,
  };
}

describe('parseAeroApiFlight', () => {
  it('maps a scheduled flight into a local-time snapshot', () => {
    const s = parseAeroApiFlight(fixture());
    expect(s).not.toBeNull();
    expect(s!.flightIata).toBe('K6829'); // ident_iata preferred over ICAO ident
    expect(s!.status).toBe('scheduled');
    expect(s!.airline).toBe('K6');
    // UTC 03:00 => Phnom Penh 10:00, and the flight date is the ORIGIN-local day.
    expect(s!.dep.scheduled).toBe('2026-08-30T10:00:00+07:00');
    expect(s!.dep.estimated).toBe('2026-08-30T10:25:00+07:00');
    expect(s!.flightDate).toBe('2026-08-30');
    expect(s!.dep.delayMin).toBe(25); // 1500 s
    expect(s!.arr.delayMin).toBe(20);
    expect(s!.dep.gate).toBe('B3');
    expect(s!.dep.terminal).toBe('M');
    expect(s!.dep.iata).toBe('PNH');
    expect(s!.arr.iata).toBe('SAI');
  });

  it('derives the flight date across midnight in the origin zone', () => {
    // UTC 20:00 on the 30th is already the 31st in +07:00.
    const s = parseAeroApiFlight(fixture({ scheduled_out: '2026-08-30T20:00:00Z' }));
    expect(s!.flightDate).toBe('2026-08-31');
  });

  it('derives our status vocabulary: flags win, then actuals', () => {
    expect(parseAeroApiFlight(fixture({ cancelled: true }))!.status).toBe('cancelled');
    expect(
      parseAeroApiFlight(fixture({ diverted: true, actual_on: '2026-08-30T04:05:00Z' }))!
        .status,
    ).toBe('diverted'); // the flag wins over the landing time
    expect(
      parseAeroApiFlight(fixture({ actual_on: '2026-08-30T04:05:00Z' }))!.status,
    ).toBe('landed');
    expect(
      parseAeroApiFlight(fixture({ actual_off: '2026-08-30T03:10:00Z' }))!.status,
    ).toBe('active');
  });

  it('falls back to runway times when gate times are missing', () => {
    const s = parseAeroApiFlight(
      fixture({ scheduled_out: null, scheduled_off: '2026-08-30T03:05:00Z' }),
    );
    expect(s!.dep.scheduled).toBe('2026-08-30T10:05:00+07:00');
  });

  it('drops garbage items instead of throwing', () => {
    expect(parseAeroApiFlight(null)).toBeNull();
    expect(parseAeroApiFlight('x')).toBeNull();
    expect(parseAeroApiFlight({})).toBeNull();
  });
});

describe('flightFeedProvider', () => {
  const cfg = (over: Partial<Config>): Config =>
    ({ ENABLE_FLIGHTS: true, ...over }) as Config;

  it('prefers AeroAPI when both keys are set, falls back to aviationstack', () => {
    expect(
      flightFeedProvider(cfg({ AEROAPI_KEY: 'a', AVIATIONSTACK_API_KEY: 'b' })),
    ).toBe('aeroapi');
    expect(flightFeedProvider(cfg({ AEROAPI_KEY: 'a' }))).toBe('aeroapi');
    expect(flightFeedProvider(cfg({ AVIATIONSTACK_API_KEY: 'b' }))).toBe('aviationstack');
  });

  it('is null with no key or with the feature off', () => {
    expect(flightFeedProvider(cfg({}))).toBeNull();
    expect(
      flightFeedProvider(cfg({ ENABLE_FLIGHTS: false, AEROAPI_KEY: 'a' })),
    ).toBeNull();
  });
});
