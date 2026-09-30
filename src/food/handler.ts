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
  type Meal,
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
  MEAL_LABELS,
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
 * What a diary tool hands back. `text` goes to the model (with entry ids, so a
 * correction can name the row); `card` is the ready TABLE the user reads — the
 * caller appends it under the model's reply verbatim, after any tone pass, so
 * the figures are never re-typed by the model or rewritten by the slang pass.
 */
export interface FoodToolResult {
  text: string;
  card: string | null;
}

/** The reply as posted: the model's words, then the diary table (if any) under them. */
export function withFoodCard(text: string, card: string | null | undefined): string {
  const t = text.trim();
  if (!card) return t;
  return t ? `${t}\n\n${card}` : card;
}

/** A no-op result for runs where the diary must not be touched (scheduler/inline). */
export const FOOD_NOOP: FoodToolResult = { text: 'noop', card: null };

/**
 * Meal from the chat-local clock, for when the words don't name one: the model
 * guessing it from context filed a lunch as «Другое». Deterministic windows:
 * 04–11 завтрак · 11–16 обед · 16–18 перекус · 18–23 ужин · night = перекус.
 */
export function mealForHour(hour: number): Meal {
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 16 && hour < 18) return 'snack';
  if (hour >= 18 && hour < 23) return 'dinner';
  return 'snack';
}

const MODEL_NOTE =
  ' Под твоим ответом пользователь автоматически увидит таблицу дня (приёмы пищи, ккал, БЖУ, цель) — ' +
  'НЕ повторяй цифры и не рисуй свою таблицу; ответь одной короткой строкой (что записал, допущение по порции, если было). ' +
  'Номера #N — служебные, пользователю их не показывай.';

/**
 * Build the `log_food` handler for one person in one chat. The model gets a
 * short confirmation with the DETERMINISTIC totals; the user gets the day table.
 */
export function makeLogFoodHandler(
  chatId: number,
  tgUserId: number,
  nowFn: () => number = Date.now,
): (input: LogFoodInput) => FoodToolResult {
  return (input) => {
    const tz = foodTimezone(chatId);
    const now = nowFn();
    const today = localToday(tz, now);
    const dayCard = (date: string) => renderFoodReport(chatId, tgUserId, date, date, today);

    if (input.action === 'set_goal') {
      const g = input.goal;
      if (!g) {
        return {
          text: 'Не передана цель (goal) — спроси у пользователя дневную норму в ккал.',
          card: null,
        };
      }
      if (g.kcal <= 0) {
        const had = clearFoodGoal(chatId, tgUserId);
        return { text: had ? 'Цель по калориям снята.' : 'Цели по калориям и так не было.', card: null };
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
      return {
        text:
          `Цель записана: ${fmtNum(g.kcal)} ккал в день${macros.length ? ` (${macros.join(' · ')} г)` : ''}.` +
          MODEL_NOTE,
        card: dayCard(today),
      };
    }

    if (input.action === 'remove') {
      const ids = input.entryIds ?? [];
      if (ids.length === 0) return { text: 'Не указаны id записей (#N) — какие убрать?', card: null };
      const removed = removeFoodEntries(chatId, tgUserId, ids);
      if (removed.length === 0) {
        return {
          text: `Записей ${ids.map((i) => `#${i}`).join(', ')} в дневнике этого человека нет — ничего не удалил.`,
          card: null,
        };
      }
      const goal = getFoodGoal(chatId, tgUserId);
      const dates = [...new Set(removed.map((e) => e.localDate))];
      const totals = dates.map((d) => {
        const t = sumEntries(listFoodEntries(chatId, tgUserId, d, d));
        return `${d === today ? 'сегодня' : d}: ${kcalHeadline(t.kcal, goal)}, ${macrosLine(t, goal)}`;
      });
      return {
        text: `Удалил: ${removed.map(itemLine).join('; ')}. Итого ${totals.join('; ')}.${MODEL_NOTE}`,
        // The newest affected day is the one the user is looking at.
        card: dayCard(dates[dates.length - 1]!),
      };
    }

    const items = input.items ?? [];
    if (items.length === 0) return { text: 'Нечего записывать: items пуст.', card: null };
    // A date in the future is a misread (or a timezone slip) — clamp to today
    // rather than logging tomorrow's dinner.
    const date = input.date && input.date <= today ? input.date : today;
    // Words win («на завтрак», «перекусил»); otherwise today's meal comes from
    // the clock. A past day with no meal named stays «Другое» — the clock of
    // NOW says nothing about when yesterday's food was eaten.
    const meal = input.meal ?? (date === today ? mealForHour(zonedParts(now, tz).hour) : null);
    const added = addFoodEntries({
      chatId,
      tgUserId,
      localDate: date,
      meal,
      items: items.map((it) => ({
        name: it.name,
        grams: r1(it.grams),
        kcal: Math.round(it.kcal),
        protein: r1(it.protein),
        fat: r1(it.fat),
        carbs: r1(it.carbs),
      })),
      now,
    });
    const mealTotals = sumEntries(added);
    const day = sumEntries(listFoodEntries(chatId, tgUserId, date, date));
    const goal = getFoodGoal(chatId, tgUserId);
    return {
      text:
        `Записал (${date === today ? 'сегодня' : date}${meal ? `, ${MEAL_LABELS[meal].toLowerCase()}` : ''}): ` +
        `${added.map(itemLine).join('; ')}. ` +
        `За приём: ${fmtNum(mealTotals.kcal)} ккал · ${macrosShort(mealTotals)} г. ` +
        `За ${date === today ? 'сегодня' : 'день'} всего: ${kcalHeadline(day.kcal, goal)}, ${macrosLine(day, goal)}.` +
        (goal ? '' : ' Цели по калориям нет — можно предложить задать словами («моя норма 2000 ккал»).') +
        MODEL_NOTE,
      card: dayCard(date),
    };
  };
}

/** Build the `food_report` handler: one day in full, a range as statistics. */
export function makeFoodReportHandler(
  chatId: number,
  tgUserId: number,
  nowFn: () => number = Date.now,
): (input: FoodReportInput) => FoodToolResult {
  return (input) => {
    const today = localToday(foodTimezone(chatId), nowFn());
    const card = renderFoodReport(chatId, tgUserId, input.fromDate, input.toDate, today);
    return {
      // The model sees the same table (to comment on it) but must not re-type it.
      text:
        `${card}\n\n(Эта таблица уже будет показана пользователю под твоим ответом как есть — ` +
        'не повторяй её и цифры; можешь добавить одну короткую мысль по делу или просто ничего.)',
      card,
    };
  };
}

/** Shared by the tool and /food: resolves the range and renders the table. */
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
