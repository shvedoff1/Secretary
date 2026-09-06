import { loadConfig, type Config } from '../config.js';
import { logger } from '../logger.js';
import type { FlightPoint, FlightSnapshot } from './status.js';
import { fetchAeroApiStatuses } from './aeroapi.js';
import { fetchAeroDataBoxStatuses } from './aerodatabox.js';

// The flight feed: a per-request dispatcher over three providers (flight HTTP
// lives only here, in aeroapi.ts and in aerodatabox.ts — the splid-js /
// Open-Meteo rule). The configured keys form an ORDERED CHAIN (AeroDataBox →
// AeroAPI → aviationstack) and one request walks it top-down: a provider that
// THROWS (HTTP failure, timeout, a lapsed subscription answered as «HTTP 400:
// No active Subscription found») hands the same request to the next configured
// one, so one dead key never blinds a watch that has a working feed behind it.
// An EMPTY answer does not fall through: «no data yet» for a far-future date is
// the normal case and re-asking every feed would double the metered calls on
// every poll. When every feed fails the error names each feed's answer.
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
  return flightFeedProviders(cfg)[0] ?? null;
}

/**
 * Every configured provider, in the order a request tries them (the fallback
 * chain). Empty when the feature is off or no key is set.
 */
export function flightFeedProviders(cfg: Config = loadConfig()): FlightFeedProvider[] {
  if (!cfg.ENABLE_FLIGHTS) return [];
  const chain: FlightFeedProvider[] = [];
  if (cfg.AERODATABOX_API_KEY) chain.push('aerodatabox');
  if (cfg.AEROAPI_KEY) chain.push('aeroapi');
  if (cfg.AVIATIONSTACK_API_KEY) chain.push('aviationstack');
  return chain;
}

/** Whether the flight tools can work at all (switch on + some API key present). */
export function flightFeedConfigured(cfg: Config = loadConfig()): boolean {
  return flightFeedProvider(cfg) !== null;
}

/** Card-visible labels per provider; also what the request log line carries. */
export const PROVIDER_LABELS: Record<FlightFeedProvider, string> = {
  aerodatabox: 'AeroDataBox',
  aeroapi: 'FlightAware',
  aviationstack: 'aviationstack',
};

/** Stamp the answering feed onto each snapshot (pure; exported for tests). */
export function tagSource(
  snapshots: FlightSnapshot[],
  provider: FlightFeedProvider,
): FlightSnapshot[] {
  return snapshots.map((s) => ({ ...s, source: PROVIDER_LABELS[provider] }));
}

/** One provider's fetch; the map is injectable so the chain can be unit-tested. */
export type FlightFeedAdapter = (
  flightIata: string,
  dateLocal?: string | null,
) => Promise<FlightSnapshot[]>;

const DEFAULT_ADAPTERS: Record<FlightFeedProvider, FlightFeedAdapter> = {
  aerodatabox: (flight, date) => fetchAeroDataBoxStatuses(flight, date),
  aeroapi: (flight) => fetchAeroApiStatuses(flight),
  aviationstack: (flight) => fetchAviationstackStatuses(flight),
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/**
 * All statuses the configured feeds currently have for one IATA flight number,
 * walking the provider chain until one ANSWERS (see the header comment: a
 * throw falls through to the next provider, an empty list does not). Each
 * snapshot is stamped with the feed that answered. Throws when no provider is
 * configured, or when every one failed — with a message naming each feed's
 * answer, so the poller's warning and /flight can show the whole picture.
 */
export async function fetchFlightStatuses(
  flightIata: string,
  dateLocal?: string | null,
  opts: { cfg?: Config; adapters?: Partial<Record<FlightFeedProvider, FlightFeedAdapter>> } = {},
): Promise<FlightSnapshot[]> {
  const chain = flightFeedProviders(opts.cfg);
  if (chain.length === 0) throw new Error('flight feed is not configured');
  const adapters = { ...DEFAULT_ADAPTERS, ...opts.adapters };
  const failures: { provider: FlightFeedProvider; message: string }[] = [];
  for (const provider of chain) {
    let snapshots: FlightSnapshot[];
    try {
      snapshots = await adapters[provider](flightIata, dateLocal);
    } catch (err) {
      const message = errorText(err);
      failures.push({ provider, message });
      const next = chain[chain.indexOf(provider) + 1] ?? null;
      logger.warn(
        { provider, flight: flightIata, date: dateLocal ?? null, err, fallbackTo: next },
        next ? 'flight feed provider failed, trying the next one' : 'flight feed provider failed',
      );
      continue;
    }
    // One INFO line per metered request: which feed, for what, and how much it
    // saw — the first thing to read when an answer looks thin or stale. When a
    // feed before it failed, that is named too.
    logger.info(
      {
        provider,
        flight: flightIata,
        date: dateLocal ?? null,
        results: snapshots.length,
        fallbackFrom: failures.length > 0 ? failures.map((f) => f.provider) : undefined,
      },
      'flight feed request',
    );
    return tagSource(snapshots, provider);
  }
  // A lone provider keeps its own message verbatim (the poller's status
  // classifier reads it); a chain names each feed's answer in order.
  if (failures.length === 1) throw new Error(failures[0]!.message);
  throw new Error(
    failures.map((f) => `${PROVIDER_LABELS[f.provider]}: ${f.message}`).join(' → '),
  );
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
