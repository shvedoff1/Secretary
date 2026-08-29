import { logger } from '../logger.js';
import type { FlightStatusInput } from '../llm/schema.js';
import { listFlightWatches } from '../db/repos/flightWatch.repo.js';
import { fetchFlightStatuses } from './feed.js';
import {
  normalizeFlightNumber,
  pickSnapshot,
  renderFlightCard,
} from './status.js';

/**
 * Build the `flight_status` tool handler — the on-demand «проверь статус рейса
 * K6829» check. Shared by the live chat flow, inline mode and the scheduler (a
 * recurring «каждое утро чекни мой рейс» task uses the same path). Returns a
 * ready text card the model relays; every miss states exactly what is missing
 * so the model never fills the gap from training data.
 *
 * `chatId` is passed only by the LIVE flow: when set and no watch covers the
 * asked flight, the card carries a one-line offer to arm one. A status check
 * does NOT arm a watch by itself — without the hint people reasonably assume
 * the bot is now "on it" and then wonder why it stayed silent about the delay.
 * Inline and scheduled runs have watch_flight disabled, so no hint there.
 */
export function makeFlightStatusHandler(
  chatId?: number,
): (input: FlightStatusInput) => Promise<string> {
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

    // Terminal states need no watch offer — the flight's story is over.
    const watchHint = (status: string): string | null => {
      if (chatId === undefined) return null;
      if (status === 'landed' || status === 'cancelled') return null;
      const watched = listFlightWatches(chatId).some((w) => w.flight === flight);
      if (watched) return null;
      return 'ℹ️ Слежка за этим рейсом не стоит — этот ответ разовый. Скажи «следи за этим рейсом», и я сам напишу, если его отменят, перенесут, объявят посадку, он вылетит или сядет.';
    };

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
        watchHint('scheduled'),
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    return [renderFlightCard(picked), otherLine, watchHint(picked.status)]
      .filter(Boolean)
      .join('\n\n');
  };
}
