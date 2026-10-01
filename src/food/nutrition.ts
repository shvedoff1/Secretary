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

/** Day/period macro totals, against the goal when it sets them: «Б 99/150 · Ж 38/65 · У 22/300 г». */
export function macrosLine(t: Pick<Totals, 'protein' | 'fat' | 'carbs'>, goal: FoodGoal | null): string {
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

/** Compact macros for one item or subtotal: «Б 70 · Ж 9 · У 0»; '' when none were estimated. */
export function macrosShort(m: {
  protein: number | null;
  fat: number | null;
  carbs: number | null;
}): string {
  if (m.protein === null && m.fat === null && m.carbs === null) return '';
  const v = (x: number | null) => (x === null ? '?' : fmtNum(x));
  return `Б ${v(m.protein)} · Ж ${v(m.fat)} · У ${v(m.carbs)}`;
}

/** «#14 Куриная грудка (230 г) — 380 ккал · Б 70 · Ж 9 · У 0». */
export function itemLine(e: FoodEntry): string {
  const grams = e.grams ? ` (${fmtNum(e.grams)} г)` : '';
  const m = macrosShort(e);
  return `#${e.id} ${e.name}${grams} — ${fmtNum(e.kcal)} ккал${m ? ` · ${m}` : ''}`;
}

// --- User-facing tables -----------------------------------------------------
// The diary is read at a glance, so it renders as a GFM table (Telegram rich
// messages show it natively; the HTML fallback turns it into an aligned <pre>).
// No entry ids here: ids are for the model («удали последнее»), not for people —
// global ids read as a meaningless running count across days.

const TABLE_HEAD = '| | ккал | Б | Ж | У |\n|:--|--:|--:|--:|--:|';
const NAME_MAX = 16;

function cell(n: number | null): string {
  return n === null ? '?' : fmtNum(n);
}

/** Table cells never contain a pipe; long names are cut so rows stay one line. */
function cellText(s: string): string {
  const clean = s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return [...clean].length > NAME_MAX
    ? `${[...clean].slice(0, NAME_MAX - 1).join('').trimEnd()}…`
    : clean;
}

function row(label: string, kcal: string, p: string, f: string, c: string): string {
  return `| ${label} | ${kcal} | ${p} | ${f} | ${c} |`;
}

function boldRow(label: string, t: Totals): string {
  return row(
    `**${label}**`,
    `**${fmtNum(t.kcal)}**`,
    `**${fmtNum(t.protein)}**`,
    `**${fmtNum(t.fat)}**`,
    `**${fmtNum(t.carbs)}**`,
  );
}

/** Goal and what is left of it (negative = over), macro cells «—» when not targeted. */
function goalRows(t: Totals, goal: FoodGoal): string[] {
  const g = (v: number | null) => (v ? fmtNum(v) : '—');
  const left = (v: number | null, eaten: number) =>
    v ? (v - eaten < 0 ? `−${fmtNum(eaten - v)}` : fmtNum(v - eaten)) : '—';
  return [
    row('Цель', g(goal.kcal), g(goal.protein), g(goal.fat), g(goal.carbs)),
    row(
      'Осталось',
      left(goal.kcal, t.kcal),
      left(goal.protein, t.protein),
      left(goal.fat, t.fat),
      left(goal.carbs, t.carbs),
    ),
  ];
}

/** Title + progress line above a day table. */
function dayTitle(t: Totals, goal: FoodGoal | null, dateStr: string, label: string): string {
  const title = `**${label}, ${weekday(dateStr)} ${shortDate(dateStr)}**`;
  if (!goal) return `${title} · ${fmtNum(t.kcal)} ккал`;
  const pct = Math.round((t.kcal / goal.kcal) * 100);
  return `${title} · ${fmtNum(t.kcal)} из ${fmtNum(goal.kcal)} ккал\n${progressBar(t.kcal, goal.kcal)} ${pct}%`;
}

/**
 * Full diary of ONE day as a table: a bold subtotal row per meal (in day order)
 * with its items under it, then the day total, and with a goal — the goal and
 * what is left of it for kcal and each macro.
 */
export function renderDay(
  entries: FoodEntry[],
  goal: FoodGoal | null,
  dateStr: string,
  label: string,
): string {
  if (entries.length === 0) {
    const title = `**${label}, ${weekday(dateStr)} ${shortDate(dateStr)}**`;
    return `${title} — пока ничего не записано.${goal ? ` Цель — ${fmtNum(goal.kcal)} ккал.` : ''}`;
  }
  const t = sumEntries(entries);
  const rows: string[] = [];
  for (const meal of MEAL_ORDER) {
    const group = entries.filter((e) => e.meal === meal);
    if (group.length === 0) continue;
    rows.push(boldRow(meal ? MEAL_LABELS[meal] : 'Другое', sumEntries(group)));
    for (const e of group) {
      const grams = e.grams ? ` ${fmtNum(e.grams)}г` : '';
      rows.push(
        row(`· ${cellText(e.name)}${grams}`, fmtNum(e.kcal), cell(e.protein), cell(e.fat), cell(e.carbs)),
      );
    }
  }
  rows.push(boldRow('Итого', t));
  if (goal) rows.push(...goalRows(t, goal));
  const out = [dayTitle(t, goal, dateStr, label), '', TABLE_HEAD, ...rows];
  if (t.missingMacros > 0) {
    out.push('', `*? — БЖУ не оценены (${t.missingMacros} поз.), в итог не вошли*`);
  }
  return out.join('\n');
}

/**
 * Statistics over a period as a table: one row per day (days with nothing logged
 * show «—» and are kept OUT of the average — an unlogged day is not a
 * zero-calorie day), the average of logged days, the goal, and how many logged
 * days stayed within it.
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
  const title = `**Питание ${shortDate(fromDate)}–${shortDate(toDate)}**`;
  const rows: string[] = [];
  const logged: Totals[] = [];
  for (const d of days) {
    const list = byDay.get(d);
    const label = `${weekday(d)} ${shortDate(d)}`;
    if (!list || list.length === 0) {
      rows.push(row(label, '—', '', '', ''));
      continue;
    }
    const t = sumEntries(list);
    logged.push(t);
    const over = goal && t.kcal > goal.kcal ? ' ↑' : '';
    rows.push(row(label, `${fmtNum(t.kcal)}${over}`, fmtNum(t.protein), fmtNum(t.fat), fmtNum(t.carbs)));
  }
  if (logged.length === 0) return `${title} — за этот период ничего не записано.`;
  const n = logged.length;
  const avg = (k: 'kcal' | 'protein' | 'fat' | 'carbs') => logged.reduce((s, t) => s + t[k], 0) / n;
  const avgTotals: Totals = {
    kcal: avg('kcal'),
    protein: avg('protein'),
    fat: avg('fat'),
    carbs: avg('carbs'),
    missingMacros: 0,
  };
  rows.push(boldRow('Среднее', avgTotals));
  if (goal) {
    const g = (v: number | null) => (v ? fmtNum(v) : '—');
    rows.push(row('Цель', g(goal.kcal), g(goal.protein), g(goal.fat), g(goal.carbs)));
  }
  const out = [title, '', TABLE_HEAD.replace('| |', '| День |'), ...rows, ''];
  const notes = [`среднее по ${n} дн. с записями`];
  if (goal) {
    const within = logged.filter((t) => t.kcal <= goal.kcal).length;
    notes.push(`в цель по ккал: ${within} из ${n}`, '↑ — перебор');
  }
  out.push(`*${notes.join(' · ')}*`);
  return out.join('\n');
}

/** One entry the way the MODEL sees it: id handle + name + kcal (+ date when asked). */
export function entryRef(e: FoodEntry, withDate = false): string {
  return `#${e.id} ${e.name} ${fmtNum(e.kcal)}${withDate ? ` (${e.localDate})` : ''}`;
}

/**
 * Compact context-block line: the sender's diary for TODAY and, when it has
 * entries, YESTERDAY — with entry ids, so «убери шпроты» / «картошка была сырая»
 * can name the row. Yesterday matters: a late-evening meal is fixed after
 * midnight, and with only today visible the model had no id to remove and asked
 * the user for one. Null when there is nothing to show (keeps the block shape
 * stable for chats that never log food).
 */
export function foodContextLine(
  days: { label: string; date: string; entries: FoodEntry[] }[],
  goal: FoodGoal | null,
  maxItems = 12,
): string | null {
  const [first, ...rest] = days;
  if (!first) return null;
  const others = rest.filter((d) => d.entries.length > 0);
  if (first.entries.length === 0 && others.length === 0 && !goal) return null;
  const part = (d: { label: string; date: string; entries: FoodEntry[] }) => {
    const t = sumEntries(d.entries);
    const kcal = goal ? `${fmtNum(t.kcal)} of goal ${fmtNum(goal.kcal)} kcal` : `${fmtNum(t.kcal)} kcal`;
    const shown = d.entries.slice(-maxItems);
    const hidden = d.entries.length - shown.length;
    const items =
      shown.length > 0
        ? `: ${hidden > 0 ? `(+${hidden} earlier) ` : ''}${shown.map((e) => entryRef(e)).join('; ')}`
        : ' — nothing logged yet';
    return `${d.label} ${d.date}: ${kcal} (${macrosLine(t, goal)})${items}`;
  };
  return (
    'Food diary of the sender (#ids are internal handles for log_food remove — never show them): ' +
    [first, ...others].map(part).join(' | ')
  );
}
