import { loadConfig, type Config } from '../config.js';
import type { FlightPoint, FlightSnapshot } from './status.js';

// aviationstack client. This is the ONLY place flight-status HTTP happens
// (mirrors the splid-js / Open-Meteo / dota-feed rule). One quirk drives the
// design: the free plan neither filters by `flight_date` nor serves HTTPS, so
// we always query by `flight_iata` alone (the feed returns the flight's recent/
// nearby days) and pick the wanted date CLIENT-side in status.ts — a watch for
// a date the feed hasn't published yet is "no data yet", not an error.

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

/** Whether the flight tools can work at all (switch on + API key present). */
export function flightFeedConfigured(cfg: Config = loadConfig()): boolean {
  return cfg.ENABLE_FLIGHTS && !!cfg.AVIATIONSTACK_API_KEY;
}

/**
 * All statuses the feed currently has for one IATA flight number (usually the
 * same flight across a few nearby dates). Throws on transport/API errors.
 */
export async function fetchFlightStatuses(flightIata: string): Promise<FlightSnapshot[]> {
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
