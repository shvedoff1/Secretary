import { loadConfig } from '../config.js';
import type { FlightPoint, FlightSnapshot } from './status.js';

// FlightAware AeroAPI client — the pay-per-query flight feed (Personal tier:
// no monthly minimum, $5/month of usage free). Flight HTTP lives only here and
// in feed.ts (the dispatcher + aviationstack client).
//
// The shape difference that matters: AeroAPI reports times in UTC (Z suffix)
// plus each airport's IANA timezone, while the rest of the flight pipeline
// treats snapshot ISO strings as airport-LOCAL wall time (that is what boards
// show, and what renderers/diffs read). So this adapter converts every time to
// the airport's local ISO (with the real offset) before building a snapshot —
// wall-clock rendering stays local, and Date.parse deltas stay exact.

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Re-express a UTC ISO timestamp as the airport's local ISO ("2026-08-30T10:00:00+07:00").
 * Falls back to the input on a missing/bad timezone — still consistent, just UTC.
 * Pure; exported for tests.
 */
export function utcToAirportLocal(iso: string | null, timeZone: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // FlightXML-era data sometimes prefixes the zone with ':'; strip defensively.
  const tz = timeZone?.replace(/^:/, '') ?? null;
  if (!tz) return iso;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(ms));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    // Some ICU builds render midnight as "24".
    const hour = get('hour') === '24' ? '00' : get('hour');
    const m = /GMT([+-]\d{2}:\d{2})?/.exec(get('timeZoneName'));
    const offset = m?.[1] ?? '+00:00';
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${offset}`;
  } catch {
    return iso;
  }
}

interface AeroApiAirport {
  name: string | null;
  iata: string | null;
  timezone: string | null;
}

function toAirport(raw: unknown): AeroApiAirport {
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    name: str(a.name),
    iata: str(a.code_iata) ?? str(a.code),
    timezone: str(a.timezone),
  };
}

function toPoint(args: {
  airport: AeroApiAirport;
  scheduled: string | null;
  estimated: string | null;
  actual: string | null;
  delaySec: number | null;
  terminal: string | null;
  gate: string | null;
}): FlightPoint {
  const tz = args.airport.timezone;
  return {
    airport: args.airport.name,
    iata: args.airport.iata,
    scheduled: utcToAirportLocal(args.scheduled, tz),
    estimated: utcToAirportLocal(args.estimated, tz),
    actual: utcToAirportLocal(args.actual, tz),
    delayMin: args.delaySec === null ? null : Math.round(args.delaySec / 60),
    terminal: args.terminal,
    gate: args.gate,
  };
}

/**
 * Defensive parse of one AeroAPI flight into our snapshot shape; null when the
 * item isn't recognizably a flight. Status is derived deterministically:
 * explicit cancelled/diverted flags win, then actual arrival => landed, actual
 * departure => active, else scheduled — the same vocabulary the differ and the
 * renderer already speak for aviationstack.
 */
export function parseAeroApiFlight(raw: unknown): FlightSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const ident = str(f.ident_iata) ?? str(f.ident);
  if (!ident) return null;

  const origin = toAirport(f.origin);
  const destination = toAirport(f.destination);

  const dep = toPoint({
    airport: origin,
    // Gate times are what a passenger's ticket shows; runway times fill gaps.
    scheduled: str(f.scheduled_out) ?? str(f.scheduled_off),
    estimated: str(f.estimated_out) ?? str(f.estimated_off),
    actual: str(f.actual_out) ?? str(f.actual_off),
    delaySec: num(f.departure_delay),
    terminal: str(f.terminal_origin),
    gate: str(f.gate_origin),
  });
  const arr = toPoint({
    airport: destination,
    scheduled: str(f.scheduled_in) ?? str(f.scheduled_on),
    estimated: str(f.estimated_in) ?? str(f.estimated_on),
    actual: str(f.actual_in) ?? str(f.actual_on),
    delaySec: num(f.arrival_delay),
    terminal: str(f.terminal_destination),
    gate: str(f.gate_destination),
  });

  let status: string;
  if (f.cancelled === true) status = 'cancelled';
  else if (f.diverted === true) status = 'diverted';
  else if (str(f.actual_on) || str(f.actual_in)) status = 'landed';
  else if (str(f.actual_off) || str(f.actual_out)) status = 'active';
  else status = 'scheduled';

  return {
    flightIata: ident.toUpperCase(),
    // The flight's "date" is its departure day in the ORIGIN airport's own
    // clock — that is the date on the ticket the user asked about.
    flightDate: dep.scheduled?.slice(0, 10) ?? null,
    status,
    airline: str(f.operator_iata) ?? str(f.operator),
    dep,
    arr,
  };
}

/**
 * All flights AeroAPI has for one flight designator (past ~11 days to +2 days).
 * One page only — each page is a separately billed result set. Throws on
 * transport/API errors.
 */
export async function fetchAeroApiStatuses(flightIata: string): Promise<FlightSnapshot[]> {
  const cfg = loadConfig();
  const key = cfg.AEROAPI_KEY;
  if (!key) throw new Error('AEROAPI_KEY is not configured');
  const url = `${cfg.AEROAPI_BASE_URL}/flights/${encodeURIComponent(flightIata)}?max_pages=1`;
  const res = await fetch(url, {
    headers: { 'x-apikey': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(cfg.FLIGHT_FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // AeroAPI error bodies carry {title, detail} — surface the real cause
    // (bad key, quota, unknown ident) instead of a bare status code.
    const detail = str(body?.detail) ?? str(body?.title) ?? '';
    throw new Error(`AeroAPI HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const flights = body?.flights;
  if (!Array.isArray(flights)) return [];
  return flights
    .map(parseAeroApiFlight)
    .filter((s): s is FlightSnapshot => s !== null);
}
