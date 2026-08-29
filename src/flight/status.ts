// Pure flight-status logic: normalizing flight numbers, picking the right
// flight out of a feed response, diffing two status snapshots into human
// events («отменили», «перенесли вылет»), and rendering the text the chat
// sees. No HTTP and no DB here — everything is unit-testable (the poller and
// the tool handler compose these with the feed).

/** One side (departure or arrival) of a flight, as reported by the feed. */
export interface FlightPoint {
  airport: string | null;
  iata: string | null;
  /** ISO datetime strings as the feed gives them — airport-LOCAL wall time. */
  scheduled: string | null;
  estimated: string | null;
  actual: string | null;
  delayMin: number | null;
  terminal: string | null;
  gate: string | null;
}

/** Normalized status of one flight on one date. */
export interface FlightSnapshot {
  /** Normalized IATA flight number, e.g. "K6829". */
  flightIata: string;
  /** YYYY-MM-DD the feed files this flight under, or null if it didn't say. */
  flightDate: string | null;
  /** Lowercased feed status: scheduled|active|landed|cancelled|incident|diverted|unknown. */
  status: string;
  airline: string | null;
  dep: FlightPoint;
  arr: FlightPoint;
}

/** A meaningful difference between two polls of the same flight. */
export type FlightChange =
  | { kind: 'cancelled' }
  | { kind: 'diverted' }
  | { kind: 'incident' }
  | { kind: 'departed'; at: string | null }
  | { kind: 'landed'; at: string | null }
  | { kind: 'depTimeChanged'; from: string; to: string; deltaMin: number }
  | { kind: 'arrTimeChanged'; from: string; to: string; deltaMin: number };

/**
 * Normalize a user-written flight number («K6 829», «k6-829», «SU 100») into
 * the feed's IATA form ("K6829"). Returns null when the text can't be a flight
 * number, so the handler can ask instead of querying the feed with garbage.
 */
export function normalizeFlightNumber(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, '');
  // IATA: 2-char airline designator (at least one letter) + 1-4 digits + an
  // optional operational suffix letter.
  const m = /^([A-Z][A-Z0-9]|[0-9][A-Z])(\d{1,4})([A-Z]?)$/.exec(compact);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}

/** Best departure-time guess for ordering/diffing: estimated over scheduled. */
export function effectiveTime(p: FlightPoint): string | null {
  return p.estimated ?? p.scheduled;
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Pick the snapshot to report/watch out of a feed response that may cover
 * several days of the same flight number. An exact requested date wins (or
 * nothing, when that date isn't in the data yet — the feed only publishes
 * flights near their day); with no date, prefer the current/upcoming leg and
 * fall back to the most recent past one.
 */
export function pickSnapshot(
  snapshots: FlightSnapshot[],
  date: string | null,
  nowMs: number,
): FlightSnapshot | null {
  if (snapshots.length === 0) return null;
  if (date) return snapshots.find((s) => s.flightDate === date) ?? null;

  const withTime = snapshots.map((s) => ({
    s,
    ms: parseMs(effectiveTime(s.dep)) ?? parseMs(s.flightDate ? `${s.flightDate}T12:00:00Z` : null),
  }));
  // "Current or upcoming": anything that departs later than a few hours ago
  // (an in-air flight departed in the past but is still the one being asked about).
  const upcoming = withTime
    .filter((x) => x.ms !== null && x.ms >= nowMs - 6 * 3600_000)
    .sort((a, b) => a.ms! - b.ms!);
  if (upcoming.length > 0) return upcoming[0]!.s;
  const past = withTime.filter((x) => x.ms !== null).sort((a, b) => b.ms! - a.ms!);
  if (past.length > 0) return past[0]!.s;
  return snapshots[snapshots.length - 1]!;
}

/** True when a change ends the watch — the awaited event happened (or the flight is over). */
export function isTerminalChange(c: FlightChange): boolean {
  return (
    c.kind === 'cancelled' ||
    c.kind === 'diverted' ||
    c.kind === 'incident' ||
    c.kind === 'landed'
  );
}

/**
 * Diff two polls of the same flight into notify-worthy events. Time moves are
 * measured against the BASELINE snapshot (the poller only advances the baseline
 * when it notifies), so a slow creep of small delays still fires once the total
 * crosses `delayThresholdMin` instead of hiding forever under the threshold.
 * A cancellation makes time changes moot, so they're dropped alongside it.
 */
export function diffSnapshots(
  prev: FlightSnapshot,
  next: FlightSnapshot,
  delayThresholdMin: number,
): FlightChange[] {
  const changes: FlightChange[] = [];

  if (prev.status !== next.status) {
    if (next.status === 'cancelled') changes.push({ kind: 'cancelled' });
    else if (next.status === 'diverted') changes.push({ kind: 'diverted' });
    else if (next.status === 'incident') changes.push({ kind: 'incident' });
    else if (next.status === 'landed')
      changes.push({ kind: 'landed', at: next.arr.actual ?? effectiveTime(next.arr) });
    else if (next.status === 'active')
      changes.push({ kind: 'departed', at: next.dep.actual ?? effectiveTime(next.dep) });
  }

  if (changes.some((c) => c.kind === 'cancelled')) return changes;

  const timeMove = (
    kind: 'depTimeChanged' | 'arrTimeChanged',
    before: FlightPoint,
    after: FlightPoint,
  ): FlightChange | null => {
    const from = effectiveTime(before);
    const to = effectiveTime(after);
    const fromMs = parseMs(from);
    const toMs = parseMs(to);
    // Either side missing => the feed dropped a field, not a reschedule; stay quiet.
    if (from === null || to === null || fromMs === null || toMs === null) return null;
    const deltaMin = Math.round((toMs - fromMs) / 60_000);
    if (Math.abs(deltaMin) < delayThresholdMin) return null;
    return { kind, from, to, deltaMin };
  };

  const dep = timeMove('depTimeChanged', prev.dep, next.dep);
  if (dep) changes.push(dep);
  const arr = timeMove('arrTimeChanged', prev.arr, next.arr);
  if (arr) changes.push(arr);

  return changes;
}

const STATUS_RU: Record<string, string> = {
  scheduled: 'по расписанию',
  active: 'в воздухе',
  landed: 'приземлился',
  cancelled: 'отменён 🚨',
  incident: 'инцидент ⚠️',
  diverted: 'перенаправлен в другой аэропорт ⚠️',
};

export function statusRu(status: string): string {
  return STATUS_RU[status] ?? `статус «${status}»`;
}

/**
 * "DD.MM HH:MM" straight from the ISO string's own wall clock. Deliberately no
 * timezone math: the feed's times are airport-local (its UTC offsets are not
 * reliable), and airport-local is what boards and tickets show anyway.
 */
export function wallClock(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  return `${m[3]}.${m[2]} ${m[4]}:${m[5]}`;
}

function renderPoint(label: string, p: FlightPoint): string {
  const where = p.airport
    ? `${p.airport}${p.iata ? ` (${p.iata})` : ''}`
    : (p.iata ?? '—');
  const sched = wallClock(p.scheduled);
  const est = wallClock(p.estimated);
  const act = wallClock(p.actual);
  const parts: string[] = [];
  if (sched) parts.push(`по расписанию ${sched}`);
  if (est && est !== sched) parts.push(`ожидается ${est}`);
  if (act) parts.push(`фактически ${act}`);
  if (p.delayMin && p.delayMin > 0) parts.push(`задержка ${p.delayMin} мин`);
  const gate: string[] = [];
  if (p.terminal) gate.push(`терминал ${p.terminal}`);
  if (p.gate) gate.push(`гейт ${p.gate}`);
  const gateStr = gate.length > 0 ? `, ${gate.join(', ')}` : '';
  return `${label}: ${where}${gateStr} — ${parts.length > 0 ? parts.join(', ') : 'время неизвестно'}`;
}

/** The text card one flight's status renders to (fed back to the model / posted). */
export function renderFlightCard(s: FlightSnapshot): string {
  const head = [
    `✈️ ${s.flightIata}`,
    s.airline ? s.airline : null,
    s.flightDate ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    head,
    `Статус: ${statusRu(s.status)}`,
    renderPoint('Вылет', s.dep),
    renderPoint('Прилёт', s.arr),
    '(время местное для каждого аэропорта)',
  ].join('\n');
}

/** Russian one-liners for a change set — the body of a watch notification. */
export function describeChanges(changes: FlightChange[]): string[] {
  return changes.map((c) => {
    switch (c.kind) {
      case 'cancelled':
        return '🚨 рейс ОТМЕНИЛИ.';
      case 'diverted':
        return '⚠️ рейс перенаправили в другой аэропорт.';
      case 'incident':
        return '⚠️ по рейсу отмечен инцидент — проверь у авиакомпании.';
      case 'departed':
        return `🛫 вылетел${c.at ? ` в ${wallClock(c.at) ?? c.at}` : ''}.`;
      case 'landed':
        return `🛬 сел${c.at ? ` в ${wallClock(c.at) ?? c.at}` : ''}.`;
      case 'depTimeChanged': {
        const dir = c.deltaMin > 0 ? 'позже' : 'раньше';
        return `🕒 вылет перенесли: ${wallClock(c.from) ?? c.from} → ${wallClock(c.to) ?? c.to} (на ${Math.abs(c.deltaMin)} мин ${dir}).`;
      }
      case 'arrTimeChanged': {
        const dir = c.deltaMin > 0 ? 'позже' : 'раньше';
        return `🕒 прилёт теперь: ${wallClock(c.from) ?? c.from} → ${wallClock(c.to) ?? c.to} (на ${Math.abs(c.deltaMin)} мин ${dir}).`;
      }
    }
  });
}
