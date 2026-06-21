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
