/**
 * Pure logic for per-member ping "quiet hours" — the windows during which a
 * member must NOT be tagged by the /ping roll call. Evaluation is deterministic
 * and timezone-aware (each window carries its own IANA zone; the write site
 * defaults to Europe/Moscow), so the ping stays instant and LLM-free.
 */

/** One do-not-ping window. Days are ISO weekdays (1=Mon … 7=Sun); minutes are
 *  local to `timezone`, `toMin` exclusive. fromMin > toMin wraps past midnight
 *  (the window starts on a listed day and spills into the next). */
export interface MuteWindow {
  days: number[];
  fromMin: number;
  toMin: number;
  timezone: string;
}

/** "H:MM"/"HH:MM" → minutes from midnight; "24:00" allowed as an end-of-day
 *  bound. Returns null for anything malformed/out of range. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return 1440;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Local ISO weekday (1=Mon…7=Sun) and minutes-from-midnight of `at` in `tz`. */
function localClock(at: Date, tz: string): { dow: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    const get = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? '';
    const DOW: Record<string, number> = {
      Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
    };
    const dow = DOW[get('weekday')];
    // Some ICU builds render midnight as "24" with hour12:false.
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    if (!dow || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { dow, minutes: hour * 60 + minute };
  } catch {
    return null; // unknown timezone → treat as "can't evaluate"
  }
}

/** Whether `at` falls inside the window (its own timezone). */
function inWindow(w: MuteWindow, at: Date): boolean {
  const clock = localClock(at, w.timezone);
  if (!clock) return false; // broken tz must never mute someone forever
  const { dow, minutes } = clock;
  if (w.fromMin < w.toMin) {
    return w.days.includes(dow) && minutes >= w.fromMin && minutes < w.toMin;
  }
  if (w.fromMin > w.toMin) {
    // Overnight wrap: [from..24:00) on a listed day, [00:00..to) the morning after.
    if (w.days.includes(dow) && minutes >= w.fromMin) return true;
    const prev = dow === 1 ? 7 : dow - 1;
    return w.days.includes(prev) && minutes < w.toMin;
  }
  return false; // from == to → empty window
}

/** Is the member muted at `at` under any of their windows? */
export function isMutedAt(windows: MuteWindow[], at: Date): boolean {
  return windows.some((w) => inWindow(w, at));
}

const DAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return 'каждый день';
  if (sorted.join(',') === '1,2,3,4,5') return 'будни';
  if (sorted.join(',') === '6,7') return 'выходные';
  return sorted.map((d) => DAY_SHORT[d - 1]).join(',');
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Human-readable summary of a member's windows, e.g.
 *  «будни до 19:00; вс 18:00–21:00 (Europe/Moscow)». */
export function describeWindows(windows: MuteWindow[]): string {
  if (windows.length === 0) return '';
  const parts = windows.map((w) => {
    const days = describeDays(w.days);
    const range =
      w.fromMin === 0
        ? `до ${fmtMin(w.toMin)}`
        : w.toMin === 1440
          ? `с ${fmtMin(w.fromMin)}`
          : `${fmtMin(w.fromMin)}–${fmtMin(w.toMin)}`;
    return `${days} ${range}`;
  });
  // All windows share the write-site timezone in practice; show the first.
  return `${parts.join('; ')} (${windows[0]!.timezone})`;
}
