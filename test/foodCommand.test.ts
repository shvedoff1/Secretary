import { describe, it, expect } from 'vitest';
import { parseFoodArgs } from '../src/bot/commands/food.js';

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
