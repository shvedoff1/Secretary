import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FlightSnapshot } from '../src/flight/status.js';
import type { NoticeEvent } from '../src/calendar/notice.js';

// The advice model once told a user flying Etihad (EY 407) out of Bangkok to
// head for «T1 или T3 для Emirates» — invented terminals and the wrong airline.
// Flight facts now come from the flight FEED: these tests cover the flight
// number extraction, the fact line (an unknown terminal is SAID to be unknown,
// never left as a gap to fill) and the best-effort fetch.

const fetchMock = vi.fn<(flight: string, date?: string | null) => Promise<FlightSnapshot[]>>();
let configured = true;
vi.mock('../src/flight/feed.js', () => ({
  flightFeedConfigured: () => configured,
  fetchFlightStatuses: (f: string, d?: string | null) => fetchMock(f, d),
}));

const { flightNumbersIn, renderFlightFacts, flightFactsFor } = await import(
  '../src/calendar/flightFacts.js'
);

function event(over: Partial<NoticeEvent> = {}): NoticeEvent {
  return {
    uid: 'f',
    title: 'Flight EY 407: BKK to AUH',
    location: null,
    description: null,
    // 2026-09-06 21:00 Asia/Bangkok = 14:00 UTC
    startsAt: Date.UTC(2026, 8, 6, 14, 0),
    endsAt: null,
    allDay: false,
    tzid: 'Asia/Bangkok',
    ...over,
  };
}

function snapshot(over: Partial<FlightSnapshot> = {}): FlightSnapshot {
  return {
    flightIata: 'EY407',
    flightDate: '2026-09-06',
    status: 'scheduled',
    airline: 'Etihad Airways',
    dep: {
      airport: 'Suvarnabhumi',
      iata: 'BKK',
      scheduled: '2026-09-06T21:00',
      estimated: null,
      actual: null,
      delayMin: null,
      terminal: null,
      gate: null,
    },
    arr: {
      airport: 'Abu Dhabi',
      iata: 'AUH',
      scheduled: '2026-09-07T00:30',
      estimated: null,
      actual: null,
      delayMin: null,
      terminal: 'A',
      gate: null,
    },
    source: 'FlightAware',
    ...over,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  configured = true;
});

describe('flightNumbersIn', () => {
  it('finds spaced / compact / hyphenated flight numbers in title and location', () => {
    expect(flightNumbersIn({ title: 'Flight EY 407: BKK to AUH', location: null })).toEqual(['EY407']);
    expect(flightNumbersIn({ title: 'Самолёт', location: 'SGN, рейс K6-829' })).toEqual(['K6829']);
    expect(flightNumbersIn({ title: 'SU100 → SU 100', location: null })).toEqual(['SU100']);
  });

  it('ignores airport codes, years and terminal names', () => {
    expect(flightNumbersIn({ title: 'BKK to AUH, 2026, T1', location: 'Terminal 1' })).toEqual([]);
  });
});

describe('renderFlightFacts', () => {
  it('states the airline and says outright when the feed has no terminal/gate', () => {
    const line = renderFlightFacts(snapshot());
    expect(line).toContain('EY407 (Etihad Airways)');
    expect(line).toContain('Suvarnabhumi (BKK)');
    expect(line).toContain('по расписанию 06.09 21:00');
    expect(line).toContain('терминал: фид не сообщает');
    expect(line).toContain('гейт: фид не сообщает');
    expect(line).toContain('терминал A'); // arrival side, known
    expect(line).toContain('данные FlightAware');
  });

  it('flags a missing airline instead of leaving it to be guessed', () => {
    expect(renderFlightFacts(snapshot({ airline: null }))).toContain('авиакомпания: фид не сообщает');
  });
});

describe('flightFactsFor', () => {
  it('queries the feed once per flight on the departure-local date and renders the facts', async () => {
    fetchMock.mockResolvedValue([snapshot()]);
    const facts = await flightFactsFor([event({}), event({ uid: 'dup' })], 'Europe/Moscow', true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('EY407', '2026-09-06');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain('Etihad');
  });

  it('uses the event\'s own zone for the date while the chat tz is unset', async () => {
    fetchMock.mockResolvedValue([snapshot()]);
    // 21:00 Bangkok is already Sep 7 in Auckland; with tzKnown=false the
    // event's Asia/Bangkok date must win over the server default zone.
    await flightFactsFor([event({})], 'Pacific/Auckland', false);
    expect(fetchMock).toHaveBeenCalledWith('EY407', '2026-09-06');
  });

  it('adds nothing when no feed is configured or the event names no flight', async () => {
    configured = false;
    expect(await flightFactsFor([event({})], 'Europe/Moscow', true)).toEqual([]);
    configured = true;
    expect(await flightFactsFor([event({ title: 'Стоматолог' })], 'Europe/Moscow', true)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a feed miss or failure into an explicit «не называй» line, never a throw', async () => {
    fetchMock.mockResolvedValueOnce([]);
    const miss = await flightFactsFor([event({})], 'Europe/Moscow', true);
    expect(miss[0]).toContain('данных пока нет');
    expect(miss[0]).toContain('НЕ называй');

    fetchMock.mockRejectedValueOnce(new Error('503'));
    const fail = await flightFactsFor([event({})], 'Europe/Moscow', true);
    expect(fail[0]).toContain('недоступен');
    expect(fail[0]).toContain('НЕ называй');
  });

  it('labels data for another date as such', async () => {
    fetchMock.mockResolvedValue([snapshot({ flightDate: '2026-09-05' })]);
    const facts = await flightFactsFor([event({})], 'Europe/Moscow', true, Date.UTC(2026, 8, 6));
    expect(facts[0]).toContain('данные за 2026-09-05');
  });
});
