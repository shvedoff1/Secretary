// Pure calorie-diary arithmetic and rendering. The model ESTIMATES each item;
// everything a person reads as a total, an average or a goal percentage is
// computed here, deterministically — the model never adds numbers up itself.
import type { FoodEntry, FoodGoal, Meal } from '../db/repos/food.repo.js';

export interface Totals {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  /** Items that came without macro estimates (their БЖУ is missing from the sums). */
  missingMacros: number;
}

export function sumEntries(entries: Pick<FoodEntry, 'kcal' | 'protein' | 'fat' | 'carbs'>[]): Totals {
  const t: Totals = { kcal: 0, protein: 0, fat: 0, carbs: 0, missingMacros: 0 };
  for (const e of entries) {
    t.kcal += e.kcal;
    if (e.protein === null && e.fat === null && e.carbs === null) t.missingMacros += 1;
    t.protein += e.protein ?? 0;
    t.fat += e.fat ?? 0;
    t.carbs += e.carbs ?? 0;
  }
  return t;
}

/** Thousands separated with a thin space: 12345 → «12 345». */
export function fmtNum(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** 10-cell progress bar; overflow past the goal is shown as a full bar. */
export function progressBar(value: number, goal: number, cells = 10): string {
  if (goal <= 0) return '';
  const filled = Math.max(0, Math.min(cells, Math.round((value / goal) * cells)));
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

export const MEAL_LABELS: Record<Meal, string> = {
  breakfast: 'Завтрак',
  lunch: 'Обед',
  dinner: 'Ужин',
  snack: 'Перекус',
};
const MEAL_ORDER: (Meal | null)[] = ['breakfast', 'lunch', 'dinner', 'snack', null];

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** «2026-09-29» → «29.09». */
export function shortDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

/** «2026-09-29» → «вт». */
export function weekday(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

/** Every date of an inclusive range, oldest first (bounded to guard a bad input). */
export function datesInRange(fromDate: string, toDate: string, max = 366): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  let t = Date.UTC(fy!, fm! - 1, fd!);
  for (let i = 0; i < max; i++) {
    const s = new Date(t).toISOString().slice(0, 10);
    if (s > toDate) break;
    out.push(s);
    t += 86_400_000;
  }
  return out;
}

function macrosLine(t: Totals, goal: FoodGoal | null): string {
  const part = (label: string, v: number, g: number | null | undefined) =>
    `${label} ${fmtNum(v)}${g ? `/${fmtNum(g)}` : ''}`;
  return `${part('Б', t.protein, goal?.protein)} · ${part('Ж', t.fat, goal?.fat)} · ${part('У', t.carbs, goal?.carbs)} г`;
}

/** Headline «1 240 / 2 000 ккал ▓▓▓▓▓▓░░░░ 62% (осталось 760)», or just the kcal. */
export function kcalHeadline(kcal: number, goal: FoodGoal | null): string {
  if (!goal) return `${fmtNum(kcal)} ккал`;
  const pct = Math.round((kcal / goal.kcal) * 100);
  const left = goal.kcal - kcal;
  const tail = left >= 0 ? `осталось ${fmtNum(left)}` : `перебор ${fmtNum(-left)}`;
  return `${fmtNum(kcal)} / ${fmtNum(goal.kcal)} ккал ${progressBar(kcal, goal.kcal)} ${pct}% (${tail})`;
}

function itemLine(e: FoodEntry): string {
  const grams = e.grams ? ` (${fmtNum(e.grams)} г)` : '';
  return `#${e.id} ${e.name}${grams} — ${fmtNum(e.kcal)} ккал`;
}

/** Full diary of ONE day: headline, macros, then items grouped by meal. */
export function renderDay(
  entries: FoodEntry[],
  goal: FoodGoal | null,
  dateStr: string,
  label: string,
): string {
  const head = `🍽 ${label} (${weekday(dateStr)} ${shortDate(dateStr)})`;
  if (entries.length === 0) {
    return `${head}: пока ничего не записано.${goal ? ` Цель — ${fmtNum(goal.kcal)} ккал.` : ''}`;
  }
  const t = sumEntries(entries);
  const lines = [`${head}: ${kcalHeadline(t.kcal, goal)}`, macrosLine(t, goal)];
  for (const meal of MEAL_ORDER) {
    const group = entries.filter((e) => e.meal === meal);
    if (group.length === 0) continue;
    const sub = sumEntries(group);
    lines.push('');
    lines.push(`${meal ? MEAL_LABELS[meal] : 'Без приёма пищи'} — ${fmtNum(sub.kcal)} ккал`);
    for (const e of group) lines.push(`  ${itemLine(e)}`);
  }
  if (t.missingMacros > 0) {
    lines.push('');
    lines.push(`(у ${t.missingMacros} поз. БЖУ не оценены — в суммы не вошли)`);
  }
  return lines.join('\n');
}

/**
 * Statistics over a period: one line per day (days with nothing logged are shown
 * as gaps and kept OUT of the average — an unlogged day is not a zero-calorie day),
 * then averages and, with a goal, how many logged days stayed within it.
 */
export function renderPeriod(
  entries: FoodEntry[],
  goal: FoodGoal | null,
  fromDate: string,
  toDate: string,
): string {
  const days = datesInRange(fromDate, toDate);
  const byDay = new Map<string, FoodEntry[]>();
  for (const e of entries) {
    const list = byDay.get(e.localDate) ?? [];
    list.push(e);
    byDay.set(e.localDate, list);
  }
  const lines = [`📊 Питание ${shortDate(fromDate)}–${shortDate(toDate)}`];
  const logged: Totals[] = [];
  for (const d of days) {
    const list = byDay.get(d);
    if (!list || list.length === 0) {
      lines.push(`${weekday(d)} ${shortDate(d)} — не записано`);
      continue;
    }
    const t = sumEntries(list);
    logged.push(t);
    const pct = goal ? ` (${Math.round((t.kcal / goal.kcal) * 100)}%)` : '';
    lines.push(`${weekday(d)} ${shortDate(d)} — ${fmtNum(t.kcal)} ккал${pct}`);
  }
  if (logged.length === 0) {
    lines.push('', 'За этот период ничего не записано.');
    return lines.join('\n');
  }
  const n = logged.length;
  const avg = (k: keyof Omit<Totals, 'missingMacros'>) =>
    logged.reduce((s, t) => s + t[k], 0) / n;
  lines.push('');
  lines.push(`В среднем за ${n} дн. с записями: ${fmtNum(avg('kcal'))} ккал`);
  lines.push(
    `Б ${fmtNum(avg('protein'))} · Ж ${fmtNum(avg('fat'))} · У ${fmtNum(avg('carbs'))} г в день`,
  );
  if (goal) {
    const within = logged.filter((t) => t.kcal <= goal.kcal).length;
    lines.push(`В цель (${fmtNum(goal.kcal)} ккал) уложился ${within} из ${n} дн.`);
  }
  return lines.join('\n');
}

/**
 * Compact line for the context block: the sender's TODAY so far, with entry ids so
 * «убери последнее / вычеркни кофе» can name the row. Null when there is nothing
 * to show (keeps the block shape stable for chats that never log food).
 */
export function foodContextLine(
  entries: FoodEntry[],
  goal: FoodGoal | null,
  dateStr: string,
  maxItems = 12,
): string | null {
  if (entries.length === 0 && !goal) return null;
  const t = sumEntries(entries);
  const total = goal ? `${fmtNum(t.kcal)} of goal ${fmtNum(goal.kcal)} kcal` : `${fmtNum(t.kcal)} kcal`;
  const shown = entries.slice(-maxItems);
  const hidden = entries.length - shown.length;
  const items =
    shown.length > 0
      ? `: ${hidden > 0 ? `(+${hidden} earlier) ` : ''}${shown
          .map((e) => `#${e.id} ${e.name} ${fmtNum(e.kcal)}`)
          .join('; ')}`
      : ' — nothing logged yet';
  return `Food diary of the sender, today ${dateStr}: ${total}${items}`;
}
