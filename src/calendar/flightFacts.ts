import { logger } from '../logger.js';
import { flightFeedConfigured, fetchFlightStatuses } from '../flight/feed.js';
import {
  normalizeFlightNumber,
  pickSnapshot,
  statusRu,
  wallClock,
  type FlightPoint,
  type FlightSnapshot,
} from '../flight/status.js';
import { eventLocalDate, type NoticeEvent } from './notice.js';

// Ground truth for the advice line's FLIGHT facts. The advice model, asked for
// «concrete» prep, used to fill the gaps from memory — and memory is exactly
// where airports and airlines blur: it told a user flying Etihad (EY) out of
// Bangkok to head for «терминал T1 или T3 для Emirates», neither of which
// exists at BKK. The prompt now bans terminals/airlines/gates that aren't in
// the data; this module is what PUTS them in the data when a flight feed is
// configured (same feeds as the flight_status tool). Best-effort: a feed
// error or an unconfigured feed simply adds nothing, and the reminder ships.

const FLIGHT_NO_RE = /\b([A-Z][A-Z0-9]|\d[A-Z])[ -]?(\d{2,4})\b/g;

/** Flight numbers named in an event's title/location (normalized, deduped). Pure. */
export function flightNumbersIn(e: Pick<NoticeEvent, 'title' | 'location'>): string[] {
  const text = `${e.title} ${e.location ?? ''}`;
  const out = new Set<string>();
  for (const m of text.matchAll(FLIGHT_NO_RE)) {
    const n = normalizeFlightNumber(`${m[1]}${m[2]}`);
    if (n) out.add(n);
  }
  return [...out];
}

function pointFacts(p: FlightPoint): string {
  const where = p.airport ? `${p.airport}${p.iata ? ` (${p.iata})` : ''}` : (p.iata ?? '—');
  const parts: string[] = [];
  const sched = wallClock(p.scheduled);
  const est = wallClock(p.estimated);
  const act = wallClock(p.actual);
  if (sched) parts.push(`по расписанию ${sched}`);
  if (est && est !== sched) parts.push(`ожидается ${est}`);
  if (act) parts.push(`фактически ${act}`);
  if (p.delayMin && p.delayMin > 0) parts.push(`задержка ${p.delayMin} мин`);
  parts.push(p.terminal ? `терминал ${p.terminal}` : 'терминал: фид не сообщает');
  parts.push(p.gate ? `гейт ${p.gate}` : 'гейт: фид не сообщает');
  return `${where} — ${parts.join(', ')}`;
}

/**
 * One detail line per flight, written for the advice model: exact figures it
 * may relay, and an explicit «не сообщает» where the feed had nothing — an
 * unknown terminal must stay unknown in the advice, not be filled from memory.
 * Pure; exported for tests.
 */
export function renderFlightFacts(s: FlightSnapshot, note?: string | null): string {
  const airline = s.airline ? ` (${s.airline})` : ' (авиакомпания: фид не сообщает)';
  const head = `Рейс ${s.flightIata}${airline}${s.flightDate ? `, ${s.flightDate}` : ''}${s.source ? `, данные ${s.source}` : ''}`;
  return [
    `${head}: статус — ${statusRu(s.status)}`,
    `вылет ${pointFacts(s.dep)}`,
    `прилёт ${pointFacts(s.arr)}`,
    'время местное для каждого аэропорта',
    note ?? null,
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * Live flight facts for the flights named in these events — one metered feed
 * request per distinct flight number. Never throws; an event whose flight the
 * feed doesn't know yields a line saying exactly that.
 */
export async function flightFactsFor(
  events: NoticeEvent[],
  tz: string,
  tzKnown: boolean,
  nowMs = Date.now(),
): Promise<string[]> {
  if (!flightFeedConfigured()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    // The flight's date is its local date at the departure airport — the
    // event's own zone when the calendar gave one, the chat's otherwise.
    const date = eventLocalDate(e, tz, tzKnown);
    for (const flight of flightNumbersIn(e)) {
      const key = `${flight}:${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const snapshots = await fetchFlightStatuses(flight, date);
        const dated = pickSnapshot(snapshots, date, nowMs);
        const picked = dated ?? pickSnapshot(snapshots, null, nowMs);
        if (!picked) {
          out.push(
            `Рейс ${flight}, ${date}: в фиде статусов данных пока нет — терминал/гейт/авиакомпанию НЕ называй, отправь к брони или табло.`,
          );
          continue;
        }
        const note =
          dated === null && picked.flightDate && picked.flightDate !== date
            ? `ВНИМАНИЕ: это данные за ${picked.flightDate}, не за ${date} — времена/терминал на нужную дату могут отличаться`
            : null;
        out.push(renderFlightFacts(picked, note));
      } catch (err) {
        logger.warn({ err, flight, date }, 'calendar advice: flight facts fetch failed');
        out.push(
          `Рейс ${flight}, ${date}: фид статусов недоступен — терминал/гейт/авиакомпанию НЕ называй, отправь к брони или табло.`,
        );
      }
    }
  }
  return out;
}
