import { loadConfig, type Config } from '../config.js';
import type { FlightPoint, FlightSnapshot } from './status.js';
import { fetchAeroApiStatuses } from './aeroapi.js';
import { fetchAeroDataBoxStatuses } from './aerodatabox.js';

// The flight feed: a per-request dispatcher over two providers (flight HTTP
// lives only here and in aeroapi.ts — the splid-js / Open-Meteo rule). Which
// provider runs is decided by which key is configured; AeroAPI wins when both
// are set (pay-per-query with a free monthly allowance suits bursty use far
// better than aviationstack's monthly quota, and its data is fresher).
//
// The aviationstack client below keeps its original design, driven by that
// feed's free-plan quirks: no `flight_date` filter and no HTTPS, so we always
// query by `flight_iata` alone (the feed returns the flight's recent/nearby
// days) and pick the wanted date CLIENT-side in status.ts — a watch for a date
// the feed hasn't published yet is "no data yet", not an error. AeroAPI is
// queried the same one-call-per-poll way, so the metering stays predictable.

export type FlightFeedProvider = 'aerodatabox' | 'aeroapi' | 'aviationstack';

/**
 * Which provider a request would use, or null when the feature can't work.
 * Priority: AeroDataBox (the only one carrying real Boarding/GateClosed
 * statuses, and its cheap tiers cover this bot's volumes) → AeroAPI
 * (pay-per-query, fresh) → aviationstack (free-tier fallback). The user
 * steers this simply by which keys are set.
 */
export function flightFeedProvider(cfg: Config = loadConfig()): FlightFeedProvider | null {
  if (!cfg.ENABLE_FLIGHTS) return null;
  if (cfg.AERODATABOX_API_KEY) return 'aerodatabox';
  if (cfg.AEROAPI_KEY) return 'aeroapi';
  if (cfg.AVIATIONSTACK_API_KEY) return 'aviationstack';
  return null;
}

/** Whether the flight tools can work at all (switch on + some API key present). */
export function flightFeedConfigured(cfg: Config = loadConfig()): boolean {
  return flightFeedProvider(cfg) !== null;
}

/**
 * All statuses the configured feed currently has for one IATA flight number.
 * `dateLocal` is a hint: AeroDataBox has a dated endpoint (its schedule data
 * reaches into the future), the other two return nearby days and the date is
 * picked client-side as before. Throws on transport/API errors and when no
 * provider is configured.
 */
export async function fetchFlightStatuses(
  flightIata: string,
  dateLocal?: string | null,
): Promise<FlightSnapshot[]> {
  const provider = flightFeedProvider();
  if (provider === 'aerodatabox') return fetchAeroDataBoxStatuses(flightIata, dateLocal);
  if (provider === 'aeroapi') return fetchAeroApiStatuses(flightIata);
  if (provider === 'aviationstack') return fetchAviationstackStatuses(flightIata);
  throw new Error('flight feed is not configured');
}

// --- aviationstack ---

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toPoint(raw: unknown): FlightPoint {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    airport: str(p.airport),
    iata: str(p.iata),
    scheduled: str(p.scheduled),
    estimated: str(p.estimated),
    actual: str(p.actual),
    delayMin: num(p.delay),
    terminal: str(p.terminal),
    gate: str(p.gate),
  };
}

/** Defensive parse of one feed item; null when it isn't recognizably a flight. */
export function parseFeedItem(raw: unknown): FlightSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const flight = (item.flight ?? {}) as Record<string, unknown>;
  const airline = (item.airline ?? {}) as Record<string, unknown>;
  const iata = str(flight.iata);
  if (!iata) return null;
  return {
    flightIata: iata.toUpperCase(),
    flightDate: str(item.flight_date),
    status: (str(item.flight_status) ?? 'unknown').toLowerCase(),
    airline: str(airline.name),
    dep: toPoint(item.departure),
    arr: toPoint(item.arrival),
  };
}

async function fetchAviationstackStatuses(flightIata: string): Promise<FlightSnapshot[]> {
  const cfg = loadConfig();
  const key = cfg.AVIATIONSTACK_API_KEY;
  if (!key) throw new Error('AVIATIONSTACK_API_KEY is not configured');
  const url =
    `${cfg.AVIATIONSTACK_BASE_URL}/flights?` +
    new URLSearchParams({ access_key: key, flight_iata: flightIata }).toString();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(cfg.FLIGHT_FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // aviationstack reports its own errors in the body (sometimes with HTTP 200),
  // so read that first — it names the real cause (bad key, quota, plan limits).
  const err = body?.error as Record<string, unknown> | undefined;
  if (err) {
    throw new Error(
      `aviationstack error: ${String(err.code ?? '?')} ${String(err.message ?? err.info ?? '')}`.trim(),
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from aviationstack`);
  const data = body?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map(parseFeedItem)
    .filter((s): s is FlightSnapshot => s !== null);
}
