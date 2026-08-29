import { logger } from '../logger.js';
import type { FlightStatusInput } from '../llm/schema.js';
import { fetchFlightStatuses } from './feed.js';
import {
  normalizeFlightNumber,
  pickSnapshot,
  renderFlightCard,
} from './status.js';

/**
 * Build the `flight_status` tool handler — the on-demand «проверь статус рейса
 * K6829» check. Stateless; shared by the live chat flow, inline mode and the
 * scheduler (a recurring «каждое утро чекни мой рейс» task uses the same path).
 * Returns a ready text card the model relays; every miss states exactly what is
 * missing so the model never fills the gap from training data.
 */
export function makeFlightStatusHandler(): (input: FlightStatusInput) => Promise<string> {
  return async (input) => {
    const flight = normalizeFlightNumber(input.flight);
    if (!flight) {
      return `Не похоже на номер рейса: «${input.flight}». Нужен код авиакомпании + номер, например K6829 или SU 100.`;
    }
    let snapshots;
    try {
      snapshots = await fetchFlightStatuses(flight, input.date);
    } catch (err) {
      logger.warn({ err, flight }, 'flight_status fetch failed');
      return `Источник данных по рейсам сейчас недоступен — статус ${flight} проверить не смог. Попробуй чуть позже.`;
    }
    if (snapshots.length === 0) {
      return `По рейсу ${flight} данных не нашёл. Проверь номер (код авиакомпании + число); возможно, рейс слишком далеко в будущем — данные появляются ближе к дате вылета.`;
    }

    const picked = pickSnapshot(snapshots, input.date, Date.now());
    const otherDates = [
      ...new Set(
        snapshots
          .map((s) => s.flightDate)
          .filter((d): d is string => d !== null && d !== picked?.flightDate),
      ),
    ];
    const otherLine =
      otherDates.length > 0 ? `Ещё вижу этот рейс на: ${otherDates.join(', ')}.` : null;

    if (!picked) {
      // A date was asked for but the feed doesn't cover it (yet) — say so and
      // show what IS known instead of pretending.
      const nearest = pickSnapshot(snapshots, null, Date.now());
      return [
        `На ${input.date} данных по ${flight} пока нет (данные появляются ближе к дате вылета). Ближайшее, что вижу:`,
        nearest ? renderFlightCard(nearest) : null,
        otherLine,
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    return [renderFlightCard(picked), otherLine].filter(Boolean).join('\n\n');
  };
}
