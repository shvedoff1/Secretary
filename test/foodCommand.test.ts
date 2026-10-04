import { describe, it, expect } from 'vitest';
import { parseFoodArgs, parseFoodDate, parseFoodRange } from '../src/bot/commands/food.js';

describe('/food argument grammar', () => {
  it('defaults to today and knows yesterday', () => {
    expect(parseFoodArgs('')).toEqual({ kind: 'day', offset: 0 });
    expect(parseFoodArgs('сегодня')).toEqual({ kind: 'day', offset: 0 });
    expect(parseFoodArgs('вчера')).toEqual({ kind: 'day', offset: -1 });
  });

  it('parses periods (week, month, Nd) and caps them', () => {
    expect(parseFoodArgs('week')).toEqual({ kind: 'period', days: 7 });
    expect(parseFoodArgs('неделя')).toEqual({ kind: 'period', days: 7 });
    expect(parseFoodArgs('month')).toEqual({ kind: 'period', days: 30 });
    expect(parseFoodArgs('14d')).toEqual({ kind: 'period', days: 14 });
    expect(parseFoodArgs('99')).toEqual({ kind: 'period', days: 92 });
  });

  it('parses a goal with optional macros and a reset', () => {
    expect(parseFoodArgs('goal 2000')).toEqual({
      kind: 'goal',
      kcal: 2000,
      protein: null,
      fat: null,
      carbs: null,
    });
    expect(parseFoodArgs('цель 1800 120 60 180')).toEqual({
      kind: 'goal',
      kcal: 1800,
      protein: 120,
      fat: 60,
      carbs: 180,
    });
    expect(parseFoodArgs('goal off')).toEqual({ kind: 'goal_off' });
    // Regression: the help showed «[Б Ж У]» and it was typed literally.
    const full = { kind: 'goal', kcal: 2400, protein: 150, fat: 65, carbs: 300 };
    expect(parseFoodArgs('goal 2400 [150 65 300]')).toEqual(full);
    expect(parseFoodArgs('goal 2400 б150 ж65 у300')).toEqual(full);
    expect(parseFoodArgs('goal 2400ккал, 150/65/300')).toEqual(full);
    expect(parseFoodArgs('goal 2400 150 65 300 99')).toEqual({ kind: 'help' });
    expect(parseFoodArgs('goal abc')).toEqual({ kind: 'help' });
  });

  it('parses deletes by id, tolerating the # prefix', () => {
    expect(parseFoodArgs('del #12 13')).toEqual({ kind: 'del', ids: [12, 13] });
    expect(parseFoodArgs('del')).toEqual({ kind: 'help' });
  });

  it('falls back to help on anything else', () => {
    expect(parseFoodArgs('как дела')).toEqual({ kind: 'help' });
  });
});

describe('/food custom dates and ranges', () => {
  const today = '2026-10-04';

  it('reads a date in every common shape, inferring the latest past year', () => {
    expect(parseFoodDate('28.09', today)).toBe('2026-09-28');
    expect(parseFoodDate('28/09', today)).toBe('2026-09-28');
    expect(parseFoodDate('28.09.26', today)).toBe('2026-09-28');
    expect(parseFoodDate('28.09.2025', today)).toBe('2025-09-28');
    expect(parseFoodDate('2026-09-01', today)).toBe('2026-09-01');
    // A day-month still ahead this year means LAST year's.
    expect(parseFoodDate('28.12', today)).toBe('2025-12-28');
    expect(parseFoodDate('04.10', today)).toBe('2026-10-04');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseFoodDate('31.02', today)).toBeNull();
    expect(parseFoodDate('2026-13-01', today)).toBeNull();
  });

  it('parses ranges glued, spaced, worded and reversed', () => {
    const sep = { from: '2026-09-01', to: '2026-09-15' };
    expect(parseFoodRange('01.09-15.09', today)).toEqual(sep);
    expect(parseFoodRange('01.09 - 15.09', today)).toEqual(sep);
    expect(parseFoodRange('01.09 — 15.09', today)).toEqual(sep);
    expect(parseFoodRange('01.09 15.09', today)).toEqual(sep);
    expect(parseFoodRange('с 01.09 по 15.09', today)).toEqual(sep);
    expect(parseFoodRange('15.09-01.09', today)).toEqual(sep);
    expect(parseFoodRange('2026-09-01 2026-09-15', today)).toEqual(sep);
    expect(parseFoodRange('01.09..15.09', today)).toEqual(sep);
  });

  it('a single date is a one-day range, and non-dates are not ranges', () => {
    expect(parseFoodRange('28.09', today)).toEqual({ from: '2026-09-28', to: '2026-09-28' });
    expect(parseFoodRange('week', today)).toBeNull();
    expect(parseFoodRange('goal 2400', today)).toBeNull();
    expect(parseFoodRange('01.09 15.09 20.09', today)).toBeNull();
    expect(parseFoodRange('31.02-05.03', today)).toBeNull();
  });

  it('wins in /food parsing without breaking the other verbs', () => {
    expect(parseFoodArgs('01.09-15.09', today)).toEqual({ kind: 'range', from: '2026-09-01', to: '2026-09-15' });
    expect(parseFoodArgs('28.09', today)).toEqual({ kind: 'range', from: '2026-09-28', to: '2026-09-28' });
    expect(parseFoodArgs('14d', today)).toEqual({ kind: 'period', days: 14 });
    expect(parseFoodArgs('goal 2400 150 65 300', today)).toMatchObject({ kind: 'goal', kcal: 2400 });
    expect(parseFoodArgs('del 12', today)).toEqual({ kind: 'del', ids: [12] });
  });
});
