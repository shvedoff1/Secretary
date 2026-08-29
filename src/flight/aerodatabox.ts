import { loadConfig } from '../config.js';
import type { FlightPoint, FlightSnapshot } from './status.js';

// AeroDataBox client, reached through a marketplace gateway (API.market by
// default; the base URL + key header are config so a RapidAPI or direct-portal
// subscription is a .env change, not code). Flight HTTP lives only in the feed
// modules (feed.ts / aeroapi.ts / here).
//
// What this feed adds over the other two: honest pre-departure statuses —
// Boarding / GateClosed — where the airport publishes its FIDS data, mapped
// into our snapshot vocabulary as 'boarding'. Its DateTimeContract already
// carries airport-LOCAL time next to UTC, so unlike AeroAPI no timezone math
// is needed — only a format touch-up (the feed writes "2026-08-30 10:00+07:00";
// Date.parse wants a 'T'). Coverage is best-effort: airports the feed doesn't
// track live come back schedule-only (quality markers say so), which our
// baseline/diff flow tolerates naturally.

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** "2026-08-30 10:00+07:00" → "2026-08-30T10:00+07:00" (parseable, wall-clock intact). */
export function normalizeAdbTime(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s.trim().replace(' ', 'T');
}

// Feed status → our snapshot vocabulary. Everything pre-departure that isn't
// boarding (Unknown/Expected/CheckIn/Delayed) reads as 'scheduled' — the delay
// news travels through the TIME diff, not the status word. CanceledUncertain
// maps to 'incident' ("статус под вопросом"), NOT to a hard cancellation: a
// false «рейс ОТМЕНИЛИ» is the one alarm this daemon must never cry.
const STATUS_MAP: Record<string, string> = {
  canceled: 'cancelled',
  canceleduncertain: 'incident',
  diverted: 'diverted',
  arrived: 'landed',
  departed: 'active',
  enroute: 'active',
  approaching: 'active',
  boarding: 'boarding',
  gateclosed: 'boarding',
};

function toPoint(raw: unknown): FlightPoint {
  const m = (raw ?? {}) as Record<string, unknown>;
  const airport = (m.airport ?? {}) as Record<string, unknown>;
  const timeOf = (field: string): string | null =>
    normalizeAdbTime(((m[field] ?? {}) as Record<string, unknown>).local);
  return {
    airport: str(airport.shortName) ?? str(airport.name),
    iata: str(airport.iata),
    scheduled: timeOf('scheduledTime'),
    // revisedTime is the feed's estimated/actual gate time; predictedTime its
    // own model's guess — trust the airline's revision first.
    estimated: timeOf('revisedTime') ?? timeOf('predictedTime'),
    actual: timeOf('runwayTime'),
    delayMin: null,
    terminal: str(m.terminal),
    gate: str(m.gate),
  };
}

/** Defensive parse of one FlightContract; null when it isn't recognizably a flight. */
export function parseAdbFlight(raw: unknown): FlightSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const number = str(f.number);
  if (!number) return null;
  const airline = (f.airline ?? {}) as Record<string, unknown>;
  const dep = toPoint(f.departure);
  const arr = toPoint(f.arrival);
  const rawStatus = (str(f.status) ?? 'unknown').toLowerCase();
  return {
    // The feed echoes numbers with a space ("K6 829") — normalize to our form.
    flightIata: number.toUpperCase().replace(/\s+/g, ''),
    flightDate: dep.scheduled?.slice(0, 10) ?? null,
    status: STATUS_MAP[rawStatus] ?? 'scheduled',
    airline: str(airline.name) ?? str(airline.iata),
    dep,
    arr,
  };
}

/**
 * Statuses AeroDataBox has for one flight number. With a date, the dated
 * endpoint is used (schedule data reaches well into the future); without one,
 * the feed returns the nearest leg(s). One TIER-2 call per poll either way.
 * Throws on transport/API errors; 204 (nothing known) is an empty list.
 */
export async function fetchAeroDataBoxStatuses(
  flightIata: string,
  dateLocal?: string | null,
): Promise<FlightSnapshot[]> {
  const cfg = loadConfig();
  const key = cfg.AERODATABOX_API_KEY;
  if (!key) throw new Error('AERODATABOX_API_KEY is not configured');
  const url =
    `${cfg.AERODATABOX_BASE_URL}/flights/number/${encodeURIComponent(flightIata)}` +
    `${dateLocal ? `/${dateLocal}` : ''}?withAircraftImage=false&withLocation=false`;
  const res = await fetch(url, {
    headers: { [cfg.AERODATABOX_KEY_HEADER]: key, Accept: 'application/json' },
    signal: AbortSignal.timeout(cfg.FLIGHT_FETCH_TIMEOUT_MS),
  });
  if (res.status === 204) return [];
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message = str((body as Record<string, unknown> | null)?.message) ?? '';
    throw new Error(`AeroDataBox HTTP ${res.status}${message ? `: ${message}` : ''}`);
  }
  if (!Array.isArray(body)) return [];
  return body.map(parseAdbFlight).filter((s): s is FlightSnapshot => s !== null);
}
