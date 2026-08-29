import { describe, it, expect } from 'vitest';
import { normalizeAdbTime, parseAdbFlight } from '../src/flight/aerodatabox.js';
import { flightFeedProvider, tagSource } from '../src/flight/feed.js';
import type { FlightSnapshot } from '../src/flight/status.js';
import type { Config } from '../src/config.js';

// AeroDataBox adapter: the contract is the same as the other feeds' — a
// snapshot with airport-LOCAL ISO times and the shared status vocabulary —
// plus the one thing only this feed brings: real Boarding/GateClosed statuses.

describe('normalizeAdbTime', () => {
  it("touches up the feed's space-separated local time into parseable ISO", () => {
    expect(normalizeAdbTime('2026-08-30 10:00+07:00')).toBe('2026-08-30T10:00+07:00');
    expect(Number.isNaN(Date.parse(normalizeAdbTime('2026-08-30 10:00+07:00')!))).toBe(
      false,
    );
    expect(normalizeAdbTime(null)).toBeNull();
    expect(normalizeAdbTime('')).toBeNull();
  });
});

function fixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 'K6 829',
    status: 'Expected',
    airline: { name: 'Cambodia Angkor Air', iata: 'K6' },
    departure: {
      airport: {
        iata: 'PNH',
        name: 'Phnom Penh International',
        shortName: 'Phnom Penh',
        timeZone: 'Asia/Phnom_Penh',
      },
      scheduledTime: { utc: '2026-08-30 03:00Z', local: '2026-08-30 10:00+07:00' },
      revisedTime: { utc: '2026-08-30 03:25Z', local: '2026-08-30 10:25+07:00' },
      terminal: 'M',
      gate: 'B3',
      quality: ['Basic', 'Live'],
    },
    arrival: {
      airport: { iata: 'SAI', name: 'Siem Reap-Angkor International', shortName: 'Siem Reap' },
      scheduledTime: { utc: '2026-08-30 04:00Z', local: '2026-08-30 11:00+07:00' },
      quality: ['Basic'],
    },
    ...over,
  };
}

describe('parseAdbFlight', () => {
  it('maps a FlightContract into a local-time snapshot', () => {
    const s = parseAdbFlight(fixture());
    expect(s).not.toBeNull();
    expect(s!.flightIata).toBe('K6829'); // "K6 829" normalized
    expect(s!.status).toBe('scheduled'); // Expected => pre-departure bucket
    expect(s!.airline).toBe('Cambodia Angkor Air');
    expect(s!.dep.scheduled).toBe('2026-08-30T10:00+07:00');
    expect(s!.dep.estimated).toBe('2026-08-30T10:25+07:00'); // revisedTime
    expect(s!.flightDate).toBe('2026-08-30');
    expect(s!.dep.gate).toBe('B3');
    expect(s!.dep.terminal).toBe('M');
    expect(s!.dep.airport).toBe('Phnom Penh'); // shortName preferred
    expect(s!.arr.iata).toBe('SAI');
  });

  it('maps the feed statuses into the shared vocabulary', () => {
    const status = (raw: string): string => parseAdbFlight(fixture({ status: raw }))!.status;
    expect(status('Boarding')).toBe('boarding'); // the whole point of this feed
    expect(status('GateClosed')).toBe('boarding');
    expect(status('Canceled')).toBe('cancelled');
    // "May be cancelled" must NOT cry «рейс ОТМЕНИЛИ» — it reads as under-question.
    expect(status('CanceledUncertain')).toBe('incident');
    expect(status('Diverted')).toBe('diverted');
    expect(status('Arrived')).toBe('landed');
    expect(status('Departed')).toBe('active');
    expect(status('EnRoute')).toBe('active');
    expect(status('Approaching')).toBe('active');
    expect(status('CheckIn')).toBe('scheduled');
    expect(status('Delayed')).toBe('scheduled'); // the delay travels via time diffs
    expect(status('Unknown')).toBe('scheduled');
  });

  it('drops garbage items instead of throwing', () => {
    expect(parseAdbFlight(null)).toBeNull();
    expect(parseAdbFlight('x')).toBeNull();
    expect(parseAdbFlight({})).toBeNull();
  });
});

describe('flightFeedProvider priority', () => {
  const cfg = (over: Partial<Config>): Config =>
    ({ ENABLE_FLIGHTS: true, ...over }) as Config;

  it('tagSource stamps the human feed label onto snapshots', () => {
    const s = parseAdbFlight(fixture()) as FlightSnapshot;
    expect(tagSource([s], 'aerodatabox')[0]!.source).toBe('AeroDataBox');
    expect(tagSource([s], 'aeroapi')[0]!.source).toBe('FlightAware');
    expect(tagSource([s], 'aviationstack')[0]!.source).toBe('aviationstack');
  });

  it('AeroDataBox wins over both other providers when its key is set', () => {
    expect(
      flightFeedProvider(
        cfg({ AERODATABOX_API_KEY: 'x', AEROAPI_KEY: 'a', AVIATIONSTACK_API_KEY: 'b' }),
      ),
    ).toBe('aerodatabox');
    expect(flightFeedProvider(cfg({ AERODATABOX_API_KEY: 'x' }))).toBe('aerodatabox');
    expect(
      flightFeedProvider(cfg({ ENABLE_FLIGHTS: false, AERODATABOX_API_KEY: 'x' })),
    ).toBeNull();
  });
});
