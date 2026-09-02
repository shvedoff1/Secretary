import { Cron } from 'croner';

/**
 * Compute the next run time (unix ms) for a cron expression in a given timezone,
 * strictly after `after` (defaults to now). Returns null if the expression never
 * fires again or is invalid.
 */
export function nextRunMs(
  cron: string,
  timezone: string,
  after: Date = new Date(),
): number | null {
  if (!isValidTimezone(timezone)) return null;
  try {
    const job = new Cron(cron, { timezone });
    const next = job.nextRun(after);
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

/** Validate a cron expression + timezone pair without scheduling anything. */
export function isValidSchedule(cron: string, timezone: string): boolean {
  // croner doesn't reject an unknown timezone at construction time, so check it
  // explicitly alongside the cron expression.
  if (!isValidTimezone(timezone)) return false;
  try {
    new Cron(cron, { timezone });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort IANA timezone check via Intl. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Format a unix-ms instant as a human-readable local time in the given timezone. */
export function formatInTimezone(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Chat-local wall clock for the context block — `2026-09-02 17:33 (Wed)`.
 * The model reads relative/absolute timing off THIS line, never off the UTC one:
 * «через час 50» once became a 12:25 reminder because the arithmetic was done
 * on the UTC clock and then labelled as Vietnam time. Null when the zone is bad.
 */
export function formatLocalClock(ms: number, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(new Date(ms));
    const get = (t: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (${get('weekday')})`;
  } catch {
    return null;
  }
}

/**
 * The one-shot cron expression that names a given instant in a timezone —
 * `25 12 2 9 *` for 12:25 on 2 September. Used for relative reminders («через
 * час 50»): the fire time is computed deterministically from the server clock
 * and the cron is DERIVED from it for display/dedup, so the model never has to
 * turn a delay into a clock time (and get the zone wrong). Null on a bad zone.
 */
export function cronForInstant(ms: number, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (t: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === t)?.value);
    const [minute, hour, day, month] = [get('minute'), get('hour'), get('day'), get('month')];
    if ([minute, hour, day, month].some((n) => !Number.isFinite(n))) return null;
    return `${minute} ${hour} ${day} ${month} *`;
  } catch {
    return null;
  }
}

/** «через 1 ч 50 мин» / «через 3 мин» — human delay for confirmations. */
export function formatDelay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `через ${m} мин`;
  if (m === 0) return `через ${h} ч`;
  return `через ${h} ч ${m} мин`;
}
