import { logger } from '../logger.js';
import type { SurfForecastInput } from '../llm/schema.js';
import { fetchSpotForecast, targetDate } from './openMeteo.js';
import { formatForecastSummary } from './format.js';

export type { SurfSpot, SpotForecast, SpotForecastResult, ForecastDay } from './openMeteo.js';

/**
 * Build the `surf_forecast` tool handler. Stateless — the same instance is
 * shared by the live chat flow and the scheduler (so a recurring evening task
 * can produce the "where to go tomorrow" report too).
 */
export function makeSurfForecastHandler(): (input: SurfForecastInput) => Promise<string> {
  return async (input) => {
    try {
      const results = await Promise.all(
        input.spots.map((s) => fetchSpotForecast(s, input.day, input.timezone)),
      );
      const date = targetDate(input.day, input.timezone);
      return formatForecastSummary(input.day, date, results);
    } catch (err) {
      logger.error({ err }, 'surf_forecast failed');
      return 'Не получилось достать прогноз волн — попробуй ещё раз чуть позже.';
    }
  };
}
