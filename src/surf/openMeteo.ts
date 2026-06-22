// Open-Meteo client. This is the ONLY place the marine/weather HTTP API is
// touched — keep external surf data behind this module (mirrors the rule that
// splid-js lives only under providers/splid/).
//
// Both endpoints are free and need no API key. Marine has waves/swell but no
// wind; the regular forecast endpoint has wind — so one spot needs two calls.

const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

// Daytime window (inclusive, local hours) we summarise — nobody surfs at 3am.
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 19;

const FETCH_TIMEOUT_MS = 15_000;

export interface SurfSpot {
  name: string;
  latitude: number;
  longitude: number;
}

export type ForecastDay = 'today' | 'tomorrow';

/** Aggregated daytime conditions for one spot on the target day. */
export interface SpotForecast {
  name: string;
  /** YYYY-MM-DD in the chat timezone. */
  date: string;
  waveHeightAvgM: number | null;
  waveHeightMaxM: number | null;
  wavePeriodAvgS: number | null;
  waveDirectionDeg: number | null;
  swellHeightAvgM: number | null;
  swellPeriodAvgS: number | null;
  windSpeedAvg: number | null;
  windGustMax: number | null;
  windDirectionDeg: number | null;
  /** Unit string reported by Open-Meteo for wind speed, e.g. "km/h". */
  windUnit: string;
}

export type SpotForecastResult =
  | { ok: true; forecast: SpotForecast }
  | { ok: false; name: string; error: string };

interface HourlyBlock {
  time?: string[];
  [key: string]: unknown;
}

/** YYYY-MM-DD for today/tomorrow in the given IANA timezone. */
export function targetDate(day: ForecastDay, timezone: string): string {
  const offsetDays = day === 'tomorrow' ? 1 : 0;
  const when = new Date(Date.now() + offsetDays * 86_400_000);
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when);
}

async function fetchJson(base: string, params: Record<string, string>): Promise<unknown> {
  const url = `${base}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Indices of hourly entries that fall on `date` within the daytime window. */
function daytimeIndices(time: string[] | undefined, date: string): number[] {
  if (!time) return [];
  const idx: number[] = [];
  for (let i = 0; i < time.length; i++) {
    const t = time[i];
    if (!t || !t.startsWith(date)) continue;
    const hour = Number(t.slice(11, 13));
    if (hour >= DAY_START_HOUR && hour <= DAY_END_HOUR) idx.push(i);
  }
  return idx;
}

function pick(series: unknown, indices: number[]): number[] {
  if (!Array.isArray(series)) return [];
  const out: number[] = [];
  for (const i of indices) {
    const v = series[i];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return round1(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function max(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return round1(Math.max(...nums));
}

/** Circular mean for directions in degrees (0..360); plain average is wrong here. */
function circularMeanDeg(degs: number[]): number | null {
  if (degs.length === 0) return null;
  let sin = 0;
  let cos = 0;
  for (const d of degs) {
    const r = (d * Math.PI) / 180;
    sin += Math.sin(r);
    cos += Math.cos(r);
  }
  const mean = (Math.atan2(sin, cos) * 180) / Math.PI;
  return Math.round((mean + 360) % 360);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Fetch and aggregate one spot's daytime conditions for the target day.
 * Never throws: a failed spot comes back as { ok: false } so one bad spot
 * doesn't sink the whole recommendation.
 */
export async function fetchSpotForecast(
  spot: SurfSpot,
  day: ForecastDay,
  timezone: string,
): Promise<SpotForecastResult> {
  const date = targetDate(day, timezone);
  const lat = String(spot.latitude);
  const lon = String(spot.longitude);
  try {
    const [marine, weather] = await Promise.all([
      fetchJson(MARINE_URL, {
        latitude: lat,
        longitude: lon,
        hourly: 'wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period',
        timezone,
        forecast_days: '2',
      }) as Promise<{ hourly?: HourlyBlock }>,
      fetchJson(WEATHER_URL, {
        latitude: lat,
        longitude: lon,
        hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
        timezone,
        forecast_days: '2',
      }) as Promise<{ hourly?: HourlyBlock; hourly_units?: Record<string, string> }>,
    ]);

    const mIdx = daytimeIndices(marine.hourly?.time, date);
    const wIdx = daytimeIndices(weather.hourly?.time, date);

    return {
      ok: true,
      forecast: {
        name: spot.name,
        date,
        waveHeightAvgM: avg(pick(marine.hourly?.wave_height, mIdx)),
        waveHeightMaxM: max(pick(marine.hourly?.wave_height, mIdx)),
        wavePeriodAvgS: avg(pick(marine.hourly?.wave_period, mIdx)),
        waveDirectionDeg: circularMeanDeg(pick(marine.hourly?.wave_direction, mIdx)),
        swellHeightAvgM: avg(pick(marine.hourly?.swell_wave_height, mIdx)),
        swellPeriodAvgS: avg(pick(marine.hourly?.swell_wave_period, mIdx)),
        windSpeedAvg: avg(pick(weather.hourly?.wind_speed_10m, wIdx)),
        windGustMax: max(pick(weather.hourly?.wind_gusts_10m, wIdx)),
        windDirectionDeg: circularMeanDeg(pick(weather.hourly?.wind_direction_10m, wIdx)),
        windUnit: weather.hourly_units?.wind_speed_10m ?? 'km/h',
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, name: spot.name, error };
  }
}
