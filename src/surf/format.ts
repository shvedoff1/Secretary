import type { ForecastDay, SpotForecastResult, TideEvent } from './openMeteo.js';

const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

/** 0..360 degrees → 16-point compass label. */
export function degToCompass(deg: number | null): string | null {
  if (deg === null) return null;
  const i = Math.round((deg % 360) / 22.5) % 16;
  return COMPASS_16[(i + 16) % 16] ?? null;
}

function dir(deg: number | null): string {
  const c = degToCompass(deg);
  return c === null ? '—' : `${c} (${deg}°)`;
}

function num(n: number | null, unit: string): string {
  return n === null ? '—' : `${n}${unit}`;
}

function tides(events: TideEvent[], unit: string): string {
  if (events.length === 0) return 'n/a';
  return events.map((t) => `${t.type} ${t.time} (${t.heightM} ${unit})`).join(', ');
}

/**
 * Compact, data-only summary fed back to the model as the tool_result. The
 * model does the ranking and writes the final friendly recommendation — this
 * just lays out the numbers per spot so it has something concrete to reason on.
 */
export function formatForecastSummary(
  day: ForecastDay,
  date: string,
  results: SpotForecastResult[],
): string {
  const lines: string[] = [
    `Forecast for ${day} (${date}). Waves/wind are daytime averages; tides list all highs/lows for the day:`,
  ];

  const ok = results.filter((r): r is Extract<SpotForecastResult, { ok: true }> => r.ok);
  const failed = results.filter((r): r is Extract<SpotForecastResult, { ok: false }> => !r.ok);

  if (ok.length === 0) {
    lines.push('- no spot data available');
  }

  for (const { forecast: f } of ok) {
    const parts = [
      `wave ${num(f.waveHeightAvgM, ' m')} avg / ${num(f.waveHeightMaxM, ' m')} max`,
      `period ${num(f.wavePeriodAvgS, ' s')}`,
      `dir ${dir(f.waveDirectionDeg)}`,
      `swell ${num(f.swellHeightAvgM, ' m')} @ ${num(f.swellPeriodAvgS, ' s')}`,
      `wind ${num(f.windSpeedAvg, ` ${f.windUnit}`)} (gust ${num(f.windGustMax, ` ${f.windUnit}`)}) from ${dir(f.windDirectionDeg)}`,
      `tide ${tides(f.tides, f.seaLevelUnit)}`,
    ];
    lines.push(`- ${f.name}: ${parts.join(', ')}`);
  }

  if (failed.length > 0) {
    lines.push(
      `Could not fetch: ${failed.map((r) => `${r.name} (${r.error})`).join('; ')}`,
    );
  }

  return lines.join('\n');
}
