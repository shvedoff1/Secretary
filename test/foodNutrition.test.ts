import { describe, it, expect } from 'vitest';
import {
  datesInRange,
  fmtNum,
  foodContextLine,
  itemLine,
  kcalHeadline,
  macrosShort,
  progressBar,
  renderDay,
  renderPeriod,
  sumEntries,
  weekday,
} from '../src/food/nutrition.js';
import type { FoodEntry } from '../src/db/repos/food.repo.js';

// The calorie diary's whole promise is «the model estimates, the code counts».
// Everything a person reads as a total/average/percentage comes from here, so a
// wrong sum here is a wrong number in the chat.

let nextId = 1;
function entry(over: Partial<FoodEntry>): FoodEntry {
  return {
    id: nextId++,
    chatId: 1,
    tgUserId: 7,
    localDate: '2026-09-29',
    meal: null,
    name: 'Еда',
    grams: null,
    kcal: 100,
    protein: 1,
    fat: 1,
    carbs: 1,
    createdAt: 0,
    ...over,
  };
}

describe('sums and formatting', () => {
  it('adds kcal and macros, counting items with no macro estimate', () => {
    const t = sumEntries([
      entry({ kcal: 350, protein: 12, fat: 6, carbs: 60 }),
      entry({ kcal: 90, protein: null, fat: null, carbs: null }),
    ]);
    expect(t).toEqual({ kcal: 440, protein: 12, fat: 6, carbs: 60, missingMacros: 1 });
  });

  it('formats thousands with a space and rounds', () => {
    expect(fmtNum(12345.6)).toBe('12 346');
    expect(fmtNum(999)).toBe('999');
  });

  it('draws a bounded progress bar', () => {
    expect(progressBar(500, 2000)).toBe('▓▓▓░░░░░░░');
    expect(progressBar(5000, 2000)).toBe('▓▓▓▓▓▓▓▓▓▓');
    expect(progressBar(0, 2000)).toBe('░░░░░░░░░░');
  });

  it('headline reports what is left, or the overshoot', () => {
    const goal = { kcal: 2000, protein: null, fat: null, carbs: null };
    expect(kcalHeadline(1240, goal)).toContain('1 240 / 2 000 ккал');
    expect(kcalHeadline(1240, goal)).toContain('62%');
    expect(kcalHeadline(1240, goal)).toContain('осталось 760');
    expect(kcalHeadline(2300, goal)).toContain('перебор 300');
    expect(kcalHeadline(1240, null)).toBe('1 240 ккал');
  });

  it('enumerates date ranges across month ends and knows weekdays', () => {
    expect(datesInRange('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(weekday('2026-09-29')).toBe('вт');
  });
});

describe('macros on every line', () => {
  it('renders item macros, marking a partial estimate and skipping a missing one', () => {
    expect(itemLine(entry({ id: 14, name: 'Курица', grams: 230, kcal: 380, protein: 70, fat: 9, carbs: 0 }))).toBe(
      '#14 Курица (230 г) — 380 ккал · Б 70 · Ж 9 · У 0',
    );
    expect(macrosShort({ protein: 5, fat: null, carbs: 20 })).toBe('Б 5 · Ж ? · У 20');
    expect(itemLine(entry({ id: 3, name: 'Кофе', kcal: 5, protein: null, fat: null, carbs: null }))).toBe(
      '#3 Кофе — 5 ккал',
    );
  });

  it('puts БЖУ on meal subtotals and per-day stats', () => {
    const day = renderDay(
      [
        entry({ meal: 'snack', kcal: 160, protein: 8, fat: 8, carbs: 12 }),
        entry({ meal: null, kcal: 380, protein: 70, fat: 9, carbs: 0 }),
      ],
      null,
      '2026-09-30',
      'Сегодня',
    );
    expect(day).toContain('Перекус — 160 ккал · Б 8 · Ж 8 · У 12');
    expect(day).toContain('Другое — 380 ккал · Б 70 · Ж 9 · У 0');
    expect(day).not.toContain('Без приёма пищи');

    const week = renderPeriod(
      [entry({ localDate: '2026-09-29', kcal: 2000, protein: 150, fat: 60, carbs: 200 })],
      null,
      '2026-09-29',
      '2026-09-30',
    );
    expect(week).toContain('вт 29.09 — 2 000 ккал · Б 150 · Ж 60 · У 200');
  });

  it('context line carries the day macros so «сколько белка осталось» is answerable', () => {
    const line = foodContextLine(
      [entry({ kcal: 380, protein: 70, fat: 9, carbs: 0 })],
      { kcal: 2400, protein: 150, fat: 65, carbs: 300 },
      '2026-09-30',
    )!;
    expect(line).toContain('Б 70/150 · Ж 9/65 · У 0/300 г');
  });
});

describe('renderDay', () => {
  it('groups by meal in day order and shows ids for corrections', () => {
    const out = renderDay(
      [
        entry({ id: 12, meal: 'dinner', name: 'Паста', kcal: 600 }),
        entry({ id: 10, meal: 'breakfast', name: 'Овсянка', grams: 250, kcal: 300 }),
      ],
      { kcal: 2000, protein: 100, fat: null, carbs: null },
      '2026-09-29',
      'Сегодня',
    );
    expect(out.indexOf('Завтрак')).toBeLessThan(out.indexOf('Ужин'));
    expect(out).toContain('#10 Овсянка (250 г) — 300 ккал');
    expect(out).toContain('900 / 2 000 ккал');
    expect(out).toContain('Б 2/100');
  });

  it('says plainly when nothing is logged', () => {
    expect(renderDay([], null, '2026-09-29', 'Сегодня')).toContain('пока ничего не записано');
  });
});

describe('renderPeriod', () => {
  it('keeps unlogged days out of the average instead of counting them as zero', () => {
    const out = renderPeriod(
      [
        entry({ localDate: '2026-09-27', kcal: 1800 }),
        entry({ localDate: '2026-09-29', kcal: 2200 }),
      ],
      { kcal: 2000, protein: null, fat: null, carbs: null },
      '2026-09-27',
      '2026-09-29',
    );
    expect(out).toContain('пн 28.09 — не записано');
    expect(out).toContain('В среднем за 2 дн. с записями: 2 000 ккал');
    expect(out).toContain('уложился 1 из 2 дн.');
  });

  it('reports an empty period', () => {
    expect(renderPeriod([], null, '2026-09-27', '2026-09-29')).toContain('ничего не записано');
  });
});

describe('foodContextLine', () => {
  it('is null for someone who never logs (keeps the block shape stable)', () => {
    expect(foodContextLine([], null, '2026-09-29')).toBeNull();
  });

  it('lists ids and the total against the goal', () => {
    const line = foodContextLine(
      [entry({ id: 5, name: 'Банан', kcal: 105 })],
      { kcal: 1800, protein: null, fat: null, carbs: null },
      '2026-09-29',
    )!;
    expect(line).toContain('Food diary');
    expect(line).toContain('#5 Банан 105');
    expect(line).toContain('105 of goal 1 800 kcal');
  });

  it('shows a goal even with an empty day, and caps the item list', () => {
    expect(
      foodContextLine([], { kcal: 1800, protein: null, fat: null, carbs: null }, '2026-09-29'),
    ).toContain('nothing logged yet');
    const many = Array.from({ length: 15 }, (_, i) => entry({ id: 100 + i, kcal: 10 }));
    const line = foodContextLine(many, null, '2026-09-29', 12)!;
    expect(line).toContain('(+3 earlier)');
    expect(line).toContain('#114');
    expect(line).not.toContain('#100 ');
  });
});
