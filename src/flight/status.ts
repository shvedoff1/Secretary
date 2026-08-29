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
  /** Human label of the feed that answered (set by the dispatcher) — rendered on
   *  the card so «кто отвечал?» is visible in the chat, not only in server logs. */
  source?: string | null;
}

/** A meaningful difference between two polls of the same flight. */
export type FlightChange =
  | { kind: 'cancelled' }
  | { kind: 'diverted' }
  | { kind: 'incident' }
  | { kind: 'departed'; at: string | null }
  | { kind: 'landed'; at: string | null }
  | { kind: 'depTimeChanged'; from: string; to: string; deltaMin: number }
  | { kind: 'arrTimeChanged'; from: string; to: string; deltaMin: number }
  // Departure gate assigned/moved — the "boarding soon" proxy on feeds that
  // don't carry real boarding status.
  | { kind: 'gateChanged'; from: string | null; to: string }
  // Real boarding announced (AeroDataBox maps Boarding/GateClosed here, where
  // the airport publishes its FIDS data).
  | { kind: 'boarding' };

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

// Adaptive poll pacing, tiered by when the NEWS can actually happen.
// Cancellations far out are rare (a slow idle covers them); delays concentrate
// in the last hours (the aircraft's rotation is known by then); gates/boarding
// live in the final hour. In the AIR there is nothing to poll at all until the
// plane can plausibly be down — flights often land EARLY, so the wake-up is
// the expected arrival minus a 10% margin of the flight's duration, then a
// tight landing-watch. Fixed tiers, not knobs: the ratio is the design,
// mirroring memoryWeight's divisor.
export const POLL_DISTANT_MINUTES = 360; // more than 24h to departure
export const POLL_FAR_MINUTES = 180; // 12..24h
export const POLL_NEAR_MINUTES = 60; // 3..12h
export const POLL_SOON_MINUTES = 30; // 1..3h
export const POLL_CLOSE_MINUTES = 15; // final hour, and awaiting takeoff
export const POLL_LANDING_MINUTES = 10; // landing window / overdue arrival
const INFLIGHT_UNKNOWN_ARRIVAL_MINUTES = 30;
export const EARLY_ARRIVAL_FRACTION = 0.1;

/**
 * Minutes until a flight watch's next poll. Pre-departure, tiers by how far
 * the EFFECTIVE departure (estimated over scheduled) is — so a reschedule
 * moves the whole pacing window along with the new time. With no snapshot
 * yet, the watched date (assumed mid-day) stands in. In the air, sleeps until
 * expected arrival minus the early-arrival margin and only then starts the
 * landing-watch; past-due departures/arrivals poll tight — that is exactly
 * when the takeoff/landing/cancel news lands.
 */
export function adaptivePollMinutes(
  snapshot: FlightSnapshot | null,
  flightDate: string | null,
  nowMs: number,
  fallbackMinutes: number,
): number {
  // Boarding announced => departure is minutes away, whatever the times say.
  if (snapshot?.status === 'boarding') return POLL_CLOSE_MINUTES;
  if (snapshot?.status === 'active') {
    const arrMs = parseMs(effectiveTime(snapshot.arr));
    if (arrMs === null) return INFLIGHT_UNKNOWN_ARRIVAL_MINUTES;
    const depMs = parseMs(snapshot.dep.actual) ?? parseMs(effectiveTime(snapshot.dep));
    const marginMs =
      depMs !== null && arrMs > depMs
        ? (arrMs - depMs) * EARLY_ARRIVAL_FRACTION
        : POLL_CLOSE_MINUTES * 60_000;
    const wakeInMin = Math.floor((arrMs - marginMs - nowMs) / 60_000);
    return Math.max(POLL_LANDING_MINUTES, Math.min(wakeInMin, POLL_DISTANT_MINUTES));
  }
  const depMs =
    (snapshot ? parseMs(effectiveTime(snapshot.dep)) : null) ??
    (flightDate ? parseMs(`${flightDate}T12:00:00Z`) : null);
  if (depMs === null) return fallbackMinutes;
  const left = depMs - nowMs;
  if (left > 24 * 3600_000) return POLL_DISTANT_MINUTES;
  if (left > 12 * 3600_000) return POLL_FAR_MINUTES;
  if (left > 3 * 3600_000) return POLL_NEAR_MINUTES;
  if (left > 1 * 3600_000) return POLL_SOON_MINUTES;
  return POLL_CLOSE_MINUTES;
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
    else if (next.status === 'boarding') changes.push({ kind: 'boarding' });
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

  // Departure gate news matters only before the plane leaves; a feed dropping
  // the field (non-null -> null) is a data hiccup, not a change.
  if (
    (next.status === 'scheduled' || next.status === 'boarding') &&
    next.dep.gate !== null &&
    next.dep.gate !== prev.dep.gate
  ) {
    changes.push({ kind: 'gateChanged', from: prev.dep.gate, to: next.dep.gate });
  }

  return changes;
}

const STATUS_RU: Record<string, string> = {
  scheduled: 'по расписанию',
  boarding: 'идёт посадка 🛄',
  active: 'в воздухе',
  landed: 'приземлился',
  cancelled: 'отменён 🚨',
  incident: 'статус под вопросом (возможна отмена) ⚠️',
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
    `(время местное для каждого аэропорта${s.source ? ` · данные: ${s.source}` : ''})`,
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
        return '⚠️ статус рейса под вопросом (возможна отмена/инцидент) — проверь у авиакомпании.';
      case 'boarding':
        return '📢 объявлена посадка — пора к гейту!';
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
      case 'gateChanged':
        return c.from
          ? `🚪 гейт поменяли: ${c.from} → ${c.to}.`
          : `🚪 назначили гейт ${c.to} — похоже, скоро посадка.`;
    }
  });
}
