import { describe, it, expect } from 'vitest';
import {
  previousDateStr,
  startOfZonedDayMs,
  zonedDayRange,
  zonedParts,
} from '../src/util/day.js';

describe('zonedParts', () => {
  it('renders wall-clock parts in the target timezone', () => {
    // 2026-06-24T23:30:00Z is 2026-06-25 01:30 in Berlin (UTC+2 in summer).
    const p = zonedParts(Date.parse('2026-06-24T23:30:00.000Z'), 'Europe/Berlin');
    expect(p.dateStr).toBe('2026-06-25');
    expect(p.hour).toBe(1);
    expect(p.minute).toBe(30);
  });

  it('normalises midnight to hour 0', () => {
    const p = zonedParts(Date.parse('2026-06-24T22:00:00.000Z'), 'Europe/Berlin');
    expect(p.dateStr).toBe('2026-06-25');
    expect(p.hour).toBe(0);
  });
});

describe('previousDateStr', () => {
  it('steps back one day', () => {
    expect(previousDateStr('2026-06-25')).toBe('2026-06-24');
  });
  it('crosses a month boundary', () => {
    expect(previousDateStr('2026-07-01')).toBe('2026-06-30');
  });
  it('crosses a year boundary', () => {
    expect(previousDateStr('2026-01-01')).toBe('2025-12-31');
  });
});

describe('startOfZonedDayMs / zonedDayRange', () => {
  it('returns local midnight as a UTC instant', () => {
    // Local midnight in Berlin (UTC+2) is 22:00 the previous UTC day.
    const ms = startOfZonedDayMs('2026-06-25', 'Europe/Berlin');
    expect(new Date(ms).toISOString()).toBe('2026-06-24T22:00:00.000Z');
  });

  it('covers exactly 24h on a non-DST day', () => {
    const { fromMs, toMs } = zonedDayRange('2026-06-24', 'Europe/Berlin');
    expect(toMs - fromMs).toBe(24 * 60 * 60 * 1000);
  });

  it('a UTC timezone day starts at UTC midnight', () => {
    const { fromMs, toMs } = zonedDayRange('2026-06-24', 'UTC');
    expect(new Date(fromMs).toISOString()).toBe('2026-06-24T00:00:00.000Z');
    expect(new Date(toMs).toISOString()).toBe('2026-06-25T00:00:00.000Z');
  });
});
