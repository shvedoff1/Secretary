// Tool handlers for the calorie diary. The model supplies per-item ESTIMATES;
// these handlers own the dates (chat-local, from the server clock), the storage
// and every sum the user reads back — see nutrition.ts.
import { loadConfig } from '../config.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import {
  addFoodEntries,
  clearFoodGoal,
  getFoodGoal,
  listFoodEntries,
  removeFoodEntries,
  setFoodGoal,
} from '../db/repos/food.repo.js';
import type { FoodReportInput, LogFoodInput } from '../llm/schema.js';
import { zonedParts } from '../util/day.js';
import {
  datesInRange,
  fmtNum,
  foodContextLine,
  itemLine,
  kcalHeadline,
  macrosLine,
  macrosShort,
  renderDay,
  renderPeriod,
  sumEntries,
} from './nutrition.js';

/** The chat's clock for the diary (falls back to the deployment default). */
export function foodTimezone(chatId: number): string {
  return getTimezone(chatId) ?? loadConfig().DEFAULT_TIMEZONE;
}

export function localToday(tz: string, now: number = Date.now()): string {
  return zonedParts(now, tz).dateStr;
}

/** How far back a report may reach in one call (a year of per-day lines is plenty). */
const MAX_REPORT_DAYS = 92;

function dayLabel(date: string, today: string): string {
  if (date === today) return 'Сегодня';
  return date === shiftDays(today, -1) ? 'Вчера' : 'День';
}

export function shiftDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}

/** Round a model estimate for storage: kcal to 1, grams/macros to 0.1. */
function r1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

/**
 * Build the `log_food` handler for one person in one chat. Returns the tool
 * result the model relays: what was logged (with ids, so a correction can name
 * the row) plus the day's DETERMINISTIC running total against the goal.
 */
export function makeLogFoodHandler(
  chatId: number,
  tgUserId: number,
  nowFn: () => number = Date.now,
): (input: LogFoodInput) => string {
  return (input) => {
    const tz = foodTimezone(chatId);
    const today = localToday(tz, nowFn());

    if (input.action === 'set_goal') {
      const g = input.goal;
      if (!g) return 'Не передана цель (goal) — спроси у пользователя дневную норму в ккал.';
      if (g.kcal <= 0) {
        const had = clearFoodGoal(chatId, tgUserId);
        return had ? 'Цель по калориям снята.' : 'Цели по калориям и так не было.';
      }
      setFoodGoal(chatId, tgUserId, {
        kcal: Math.round(g.kcal),
        protein: r1(g.protein),
        fat: r1(g.fat),
        carbs: r1(g.carbs),
      });
      const macros = [
        g.protein ? `Б ${fmtNum(g.protein)}` : null,
        g.fat ? `Ж ${fmtNum(g.fat)}` : null,
        g.carbs ? `У ${fmtNum(g.carbs)}` : null,
      ].filter(Boolean);
      const eaten = sumEntries(listFoodEntries(chatId, tgUserId, today, today)).kcal;
      return (
        `Цель записана: ${fmtNum(g.kcal)} ккал в день${macros.length ? ` (${macros.join(' · ')} г)` : ''}. ` +
        `Сегодня уже: ${kcalHeadline(eaten, getFoodGoal(chatId, tgUserId))}.`
      );
    }

    if (input.action === 'remove') {
      const ids = input.entryIds ?? [];
      if (ids.length === 0) return 'Не указаны id записей (#N) — какие убрать?';
      const removed = removeFoodEntries(chatId, tgUserId, ids);
      if (removed.length === 0) {
        return `Записей ${ids.map((i) => `#${i}`).join(', ')} в дневнике этого человека нет — ничего не удалил.`;
      }
      const dates = [...new Set(removed.map((e) => e.localDate))];
      const goal = getFoodGoal(chatId, tgUserId);
      const totals = dates.map((d) => {
        const t = sumEntries(listFoodEntries(chatId, tgUserId, d, d));
        return `${d === today ? 'сегодня' : d}: ${kcalHeadline(t.kcal, goal)}, ${macrosLine(t, goal)}`;
      });
      return (
        `Удалил: ${removed.map(itemLine).join('; ')}. ` +
        `Итого ${totals.join('; ')}.`
      );
    }

    const items = input.items ?? [];
    if (items.length === 0) return 'Нечего записывать: items пуст.';
    // A date in the future is a misread (or a timezone slip) — clamp to today
    // rather than logging tomorrow's dinner.
    const date = input.date && input.date <= today ? input.date : today;
    const added = addFoodEntries({
      chatId,
      tgUserId,
      localDate: date,
      meal: input.meal,
      items: items.map((it) => ({
        name: it.name,
        grams: r1(it.grams),
        kcal: Math.round(it.kcal),
        protein: r1(it.protein),
        fat: r1(it.fat),
        carbs: r1(it.carbs),
      })),
      now: nowFn(),
    });
    const meal = sumEntries(added);
    const day = sumEntries(listFoodEntries(chatId, tgUserId, date, date));
    const goal = getFoodGoal(chatId, tgUserId);
    const list = added.map(itemLine).join('; ');
    return (
      `Записал (${date === today ? 'сегодня' : date}): ${list}. ` +
      `За приём: ${fmtNum(meal.kcal)} ккал · ${macrosShort(meal)} г. ` +
      `За ${date === today ? 'сегодня' : 'день'} всего: ${kcalHeadline(day.kcal, goal)}, ${macrosLine(day, goal)}.` +
      (goal ? '' : ' Цели по калориям нет — можно задать словами («моя норма 2000 ккал»).') +
      ' (Цифры — оценка. Ответь коротко, но БЖУ покажи всегда: у каждой позиции и в итоге дня; можно назвать допущение по порции.)'
    );
  };
}

/** Build the `food_report` handler: one day in full, a range as statistics. */
export function makeFoodReportHandler(
  chatId: number,
  tgUserId: number,
  nowFn: () => number = Date.now,
): (input: FoodReportInput) => string {
  return (input) => {
    const today = localToday(foodTimezone(chatId), nowFn());
    return renderFoodReport(chatId, tgUserId, input.fromDate, input.toDate, today);
  };
}

/** Shared by the tool and /food: resolves the range and renders it. */
export function renderFoodReport(
  chatId: number,
  tgUserId: number,
  fromDate: string | null,
  toDate: string | null,
  today: string,
): string {
  let from = fromDate ?? toDate ?? today;
  let to = toDate ?? fromDate ?? today;
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  if (from > to) from = to;
  if (datesInRange(from, to, MAX_REPORT_DAYS + 1).length > MAX_REPORT_DAYS) {
    from = shiftDays(to, -(MAX_REPORT_DAYS - 1));
  }
  const goal = getFoodGoal(chatId, tgUserId);
  const entries = listFoodEntries(chatId, tgUserId, from, to);
  if (from === to) return renderDay(entries, goal, from, dayLabel(from, today));
  return renderPeriod(entries, goal, from, to);
}

/** The context-block line for the sender (null when they have no diary today). */
export function foodContextFor(chatId: number, tgUserId: number, now: number = Date.now()): string | null {
  const today = localToday(foodTimezone(chatId), now);
  return foodContextLine(
    listFoodEntries(chatId, tgUserId, today, today),
    getFoodGoal(chatId, tgUserId),
    today,
  );
}
