// Timezone-aware calendar-day helpers, built only on Intl (no extra deps).
// Used by the daily spending digest to reason about "yesterday" in a chat's
// local timezone and to turn a local calendar day into a UTC instant range.

export interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number; // 0–59
  /** Local calendar date as YYYY-MM-DD. */
  dateStr: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Parse a YYYY-MM-DD string into numeric [year, month, day]. */
function splitDate(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split('-');
  return [Number(y), Number(m), Number(d)];
}

/** Wall-clock parts of `ms` as seen in `tz`. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  // 'h23' renders midnight as '24'; normalise it back to 0.
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  return {
    year,
    month,
    day,
    hour,
    minute,
    dateStr: `${map.year}-${pad(month)}-${pad(day)}`,
  };
}

/** The UTC offset (ms) in effect in `tz` at instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = zonedParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Round the source instant down to the minute so the difference is a clean
  // offset (zonedParts has minute resolution).
  return asUtc - Math.floor(utcMs / 60_000) * 60_000;
}

/**
 * The UTC instant of local midnight that starts `dateStr` (YYYY-MM-DD) in `tz`.
 * Resolves the timezone offset at that wall-clock time (DST-aware to the minute).
 */
export function startOfZonedDayMs(dateStr: string, tz: string): number {
  const [y, m, d] = splitDate(dateStr);
  const guess = Date.UTC(y, m - 1, d, 0, 0);
  // Sample the offset at the guessed instant, then correct. One correction is
  // enough except across the rare midnight DST transition, which the digest
  // tolerates.
  const offset = tzOffsetMs(guess, tz);
  return guess - offset;
}

/** YYYY-MM-DD for the day before `dateStr` (calendar arithmetic, DST-safe). */
export function previousDateStr(dateStr: string): string {
  const [y, m, d] = splitDate(dateStr);
  const prev = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
}

/** Half-open [from, to) UTC range covering the local calendar day `dateStr`. */
export function zonedDayRange(
  dateStr: string,
  tz: string,
): { fromMs: number; toMs: number } {
  const fromMs = startOfZonedDayMs(dateStr, tz);
  const [y, m, d] = splitDate(dateStr);
  const nextDay = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
  const nextStr = `${nextDay.getUTCFullYear()}-${pad(nextDay.getUTCMonth() + 1)}-${pad(nextDay.getUTCDate())}`;
  const toMs = startOfZonedDayMs(nextStr, tz);
  return { fromMs, toMs };
}
