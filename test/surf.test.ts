import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchSpotForecast,
  targetDate,
  type SpotForecastResult,
} from '../src/surf/openMeteo.js';
import { formatForecastSummary, degToCompass } from '../src/surf/format.js';
import { SurfForecastZ } from '../src/llm/schema.js';
import { buildTools, SURF_FORECAST_TOOL } from '../src/llm/tools.js';

const TZ = 'UTC';

/** 24 hourly timestamps "YYYY-MM-DDTHH:00" for the given date. */
function hourlyTimes(date: string): string[] {
  return Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
}

/**
 * Daytime hours (6..19) get `day`, the rest get `night`. Lets us assert that
 * aggregation filters to daytime: a night-only spike must NOT show up in max.
 */
function daytimeSeries(day: number, night: number, spikeAt12?: number): number[] {
  return Array.from({ length: 24 }, (_, h) => {
    if (h < 6 || h > 19) return night;
    if (spikeAt12 !== undefined && h === 12) return spikeAt12;
    return day;
  });
}

function mockFetch(date: string): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('marine-api')) {
      return new Response(
        JSON.stringify({
          hourly_units: { wave_height: 'm', wave_period: 's' },
          hourly: {
            time: hourlyTimes(date),
            wave_height: daytimeSeries(1.0, 9.0, 2.0),
            wave_period: daytimeSeries(10, 10),
            wave_direction: daytimeSeries(315, 315),
            swell_wave_height: daytimeSeries(0.8, 0.8),
            swell_wave_period: daytimeSeries(12, 12),
          },
        }),
        { status: 200 },
      );
    }
    // weather endpoint
    return new Response(
      JSON.stringify({
        hourly_units: { wind_speed_10m: 'km/h' },
        hourly: {
          time: hourlyTimes(date),
          wind_speed_10m: daytimeSeries(12, 99),
          wind_direction_10m: daytimeSeries(270, 270),
          wind_gusts_10m: daytimeSeries(18, 99, 25),
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSpotForecast', () => {
  it('aggregates only daytime hours of the target day', async () => {
    const date = targetDate('tomorrow', TZ);
    vi.stubGlobal('fetch', mockFetch(date));

    const res = await fetchSpotForecast(
      { name: 'Ribeira', latitude: 38.99, longitude: -9.42 },
      'tomorrow',
      TZ,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const f = res.forecast;
    expect(f.date).toBe(date);
    // Night value 9.0 must be excluded; daytime max is the 12:00 spike of 2.0.
    expect(f.waveHeightMaxM).toBe(2.0);
    expect(f.waveHeightAvgM).not.toBeNull();
    expect(f.waveHeightAvgM!).toBeLessThan(1.5);
    expect(f.wavePeriodAvgS).toBe(10);
    expect(f.waveDirectionDeg).toBe(315);
    expect(f.swellHeightAvgM).toBe(0.8);
    expect(f.windSpeedAvg).toBe(12);
    expect(f.windGustMax).toBe(25); // daytime spike, not the 99 night value
    expect(f.windDirectionDeg).toBe(270);
    expect(f.windUnit).toBe('km/h');
  });

  it('returns ok:false (not a throw) when the API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    );

    const res = await fetchSpotForecast(
      { name: 'Coxos', latitude: 39.0, longitude: -9.4 },
      'today',
      TZ,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.name).toBe('Coxos');
    expect(res.error).toContain('500');
  });
});

describe('formatForecastSummary', () => {
  it('lists each spot and surfaces failures separately', () => {
    const results: SpotForecastResult[] = [
      {
        ok: true,
        forecast: {
          name: 'Ribeira',
          date: '2026-06-23',
          waveHeightAvgM: 1.1,
          waveHeightMaxM: 2.0,
          wavePeriodAvgS: 10,
          waveDirectionDeg: 315,
          swellHeightAvgM: 0.8,
          swellPeriodAvgS: 12,
          windSpeedAvg: 12,
          windGustMax: 25,
          windDirectionDeg: 270,
          windUnit: 'km/h',
        },
      },
      { ok: false, name: 'Coxos', error: 'HTTP 500' },
    ];

    const out = formatForecastSummary('tomorrow', '2026-06-23', results);
    expect(out).toContain('tomorrow (2026-06-23)');
    expect(out).toContain('Ribeira');
    expect(out).toContain('NW'); // 315° wave direction
    expect(out).toContain('km/h');
    expect(out).toContain('Could not fetch: Coxos (HTTP 500)');
  });
});

describe('degToCompass', () => {
  it('maps degrees to 16-point compass labels', () => {
    expect(degToCompass(0)).toBe('N');
    expect(degToCompass(90)).toBe('E');
    expect(degToCompass(180)).toBe('S');
    expect(degToCompass(270)).toBe('W');
    expect(degToCompass(315)).toBe('NW');
    expect(degToCompass(null)).toBeNull();
  });
});

describe('SurfForecastZ', () => {
  const valid = {
    spots: [{ name: 'Ribeira', latitude: 38.99, longitude: -9.42 }],
    day: 'tomorrow',
    timezone: 'Europe/Lisbon',
  };

  it('accepts a well-formed request', () => {
    expect(SurfForecastZ.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty spot list', () => {
    expect(SurfForecastZ.safeParse({ ...valid, spots: [] }).success).toBe(false);
  });

  it('rejects more than 8 spots', () => {
    const spots = Array.from({ length: 9 }, (_, i) => ({
      name: `s${i}`,
      latitude: 0,
      longitude: 0,
    }));
    expect(SurfForecastZ.safeParse({ ...valid, spots }).success).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(
      SurfForecastZ.safeParse({
        ...valid,
        spots: [{ name: 'x', latitude: 99, longitude: 0 }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown day', () => {
    expect(SurfForecastZ.safeParse({ ...valid, day: 'monday' }).success).toBe(false);
  });
});

describe('buildTools surf gating', () => {
  it('exposes surf_forecast by default', () => {
    const names = buildTools({ enableWebSearch: false, enableExpense: false }).map((t) =>
      'name' in t ? t.name : '',
    );
    expect(names).toContain(SURF_FORECAST_TOOL);
  });

  it('omits surf_forecast when disabled', () => {
    const names = buildTools({
      enableWebSearch: false,
      enableExpense: false,
      enableSurf: false,
    }).map((t) => ('name' in t ? t.name : ''));
    expect(names).not.toContain(SURF_FORECAST_TOOL);
  });

  it('keeps surf_forecast available on scheduled runs (reminders disabled)', () => {
    const names = buildTools({
      enableWebSearch: true,
      enableExpense: false,
      enableRemember: false,
      enableReminders: false,
    }).map((t) => ('name' in t ? t.name : ''));
    expect(names).toContain(SURF_FORECAST_TOOL);
  });
});
