import { getDb } from '../client.js';

/**
 * The calorie diary (migration 034). Rows are ESTIMATES the model produced from a
 * voice note, a photo or a plain-words message; everything derived from them
 * (day totals, averages, goal progress) is computed in code, never by the model.
 * Every read is scoped to (chat_id, tg_user_id): a diary is personal.
 */
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface FoodEntry {
  id: number;
  chatId: number;
  tgUserId: number;
  localDate: string;
  meal: Meal | null;
  name: string;
  grams: number | null;
  kcal: number;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  createdAt: number;
}

export interface FoodGoal {
  kcal: number;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
}

interface EntryRow {
  id: number;
  chat_id: number;
  tg_user_id: number;
  local_date: string;
  meal: string | null;
  name: string;
  grams: number | null;
  kcal: number;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  created_at: number;
}

const MEALS = new Set<string>(['breakfast', 'lunch', 'dinner', 'snack']);

function rowToEntry(r: EntryRow): FoodEntry {
  return {
    id: r.id,
    chatId: r.chat_id,
    tgUserId: r.tg_user_id,
    localDate: r.local_date,
    meal: r.meal && MEALS.has(r.meal) ? (r.meal as Meal) : null,
    name: r.name,
    grams: r.grams,
    kcal: r.kcal,
    protein: r.protein,
    fat: r.fat,
    carbs: r.carbs,
    createdAt: r.created_at,
  };
}

const COLS =
  'id, chat_id, tg_user_id, local_date, meal, name, grams, kcal, protein, fat, carbs, created_at';

export interface NewFoodEntry {
  name: string;
  grams: number | null;
  kcal: number;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
}

/** Insert several items of one meal in one transaction; returns them with ids. */
export function addFoodEntries(args: {
  chatId: number;
  tgUserId: number;
  localDate: string;
  meal: Meal | null;
  items: NewFoodEntry[];
  now?: number;
}): FoodEntry[] {
  const db = getDb();
  const now = args.now ?? Date.now();
  const insert = db.prepare(
    `INSERT INTO food_entry
       (chat_id, tg_user_id, local_date, meal, name, grams, kcal, protein, fat, carbs, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids: number[] = [];
  db.transaction(() => {
    for (const it of args.items) {
      const info = insert.run(
        args.chatId,
        args.tgUserId,
        args.localDate,
        args.meal,
        it.name.trim(),
        it.grams,
        it.kcal,
        it.protein,
        it.fat,
        it.carbs,
        now,
      );
      ids.push(Number(info.lastInsertRowid));
    }
  })();
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT ${COLS} FROM food_entry WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(...ids) as EntryRow[];
  return rows.map(rowToEntry);
}

/** One person's entries for an inclusive chat-local date range, in logging order. */
export function listFoodEntries(
  chatId: number,
  tgUserId: number,
  fromDate: string,
  toDate: string,
): FoodEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT ${COLS} FROM food_entry
        WHERE chat_id = ? AND tg_user_id = ? AND local_date >= ? AND local_date <= ?
        ORDER BY local_date, id`,
    )
    .all(chatId, tgUserId, fromDate, toDate) as EntryRow[];
  return rows.map(rowToEntry);
}

/** Delete one person's entries by id; ids that aren't theirs are ignored. */
export function removeFoodEntries(chatId: number, tgUserId: number, ids: number[]): FoodEntry[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const marks = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM food_entry
        WHERE chat_id = ? AND tg_user_id = ? AND id IN (${marks}) ORDER BY id`,
    )
    .all(chatId, tgUserId, ...ids) as EntryRow[];
  if (rows.length === 0) return [];
  db.prepare(
    `DELETE FROM food_entry WHERE chat_id = ? AND tg_user_id = ? AND id IN (${rows
      .map(() => '?')
      .join(',')})`,
  ).run(chatId, tgUserId, ...rows.map((r) => r.id));
  return rows.map(rowToEntry);
}

/** The newest entry of a person (for «удали последнее»), or null. */
export function lastFoodEntry(chatId: number, tgUserId: number): FoodEntry | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLS} FROM food_entry WHERE chat_id = ? AND tg_user_id = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId, tgUserId) as EntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function getFoodGoal(chatId: number, tgUserId: number): FoodGoal | null {
  const row = getDb()
    .prepare('SELECT kcal, protein, fat, carbs FROM food_goal WHERE chat_id = ? AND tg_user_id = ?')
    .get(chatId, tgUserId) as FoodGoal | undefined;
  return row ?? null;
}

export function setFoodGoal(chatId: number, tgUserId: number, goal: FoodGoal): void {
  getDb()
    .prepare(
      `INSERT INTO food_goal (chat_id, tg_user_id, kcal, protein, fat, carbs, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000)
       ON CONFLICT (chat_id, tg_user_id) DO UPDATE SET
         kcal = excluded.kcal, protein = excluded.protein, fat = excluded.fat,
         carbs = excluded.carbs, updated_at = excluded.updated_at`,
    )
    .run(chatId, tgUserId, goal.kcal, goal.protein, goal.fat, goal.carbs);
}

export function clearFoodGoal(chatId: number, tgUserId: number): boolean {
  const info = getDb()
    .prepare('DELETE FROM food_goal WHERE chat_id = ? AND tg_user_id = ?')
    .run(chatId, tgUserId);
  return info.changes > 0;
}

// --- Day notes (migration 036) ----------------------------------------------

export function getDayNote(chatId: number, tgUserId: number, localDate: string): string | null {
  const row = getDb()
    .prepare('SELECT text FROM food_day_note WHERE chat_id = ? AND tg_user_id = ? AND local_date = ?')
    .get(chatId, tgUserId, localDate) as { text: string } | undefined;
  return row?.text ?? null;
}

/** Upsert a day's note; an empty/blank text deletes it. */
export function setDayNote(chatId: number, tgUserId: number, localDate: string, text: string): void {
  const t = text.trim();
  if (!t) {
    getDb()
      .prepare('DELETE FROM food_day_note WHERE chat_id = ? AND tg_user_id = ? AND local_date = ?')
      .run(chatId, tgUserId, localDate);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO food_day_note (chat_id, tg_user_id, local_date, text, updated_at)
       VALUES (?, ?, ?, ?, unixepoch() * 1000)
       ON CONFLICT (chat_id, tg_user_id, local_date) DO UPDATE SET
         text = excluded.text, updated_at = excluded.updated_at`,
    )
    .run(chatId, tgUserId, localDate, t);
}

/** Notes over an inclusive chat-local range, keyed by date. */
export function listDayNotes(
  chatId: number,
  tgUserId: number,
  fromDate: string,
  toDate: string,
): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT local_date, text FROM food_day_note
        WHERE chat_id = ? AND tg_user_id = ? AND local_date >= ? AND local_date <= ?
        ORDER BY local_date`,
    )
    .all(chatId, tgUserId, fromDate, toDate) as { local_date: string; text: string }[];
  return new Map(rows.map((r) => [r.local_date, r.text]));
}
