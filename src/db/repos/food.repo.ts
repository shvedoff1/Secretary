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

// --- Day types (migration 037) ----------------------------------------------

export interface DayType extends FoodGoal {
  id: number;
  name: string;
}

/** A person can't need more kinds of day than this — and buttons must fit. */
export const DAY_TYPES_MAX = 8;

interface DayTypeRow {
  id: number;
  name: string;
  kcal: number;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
}

/** A person's day types, in creation order (the order the buttons show). */
export function listDayTypes(chatId: number, tgUserId: number): DayType[] {
  return getDb()
    .prepare(
      `SELECT id, name, kcal, protein, fat, carbs FROM food_day_type
        WHERE chat_id = ? AND tg_user_id = ? ORDER BY id`,
    )
    .all(chatId, tgUserId) as DayTypeRow[];
}

export function getDayTypeById(chatId: number, tgUserId: number, id: number): DayType | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, kcal, protein, fat, carbs FROM food_day_type
        WHERE chat_id = ? AND tg_user_id = ? AND id = ?`,
    )
    .get(chatId, tgUserId, id) as DayTypeRow | undefined;
  return row ?? null;
}

/**
 * Find a type by the name as the person says it: exact (case-insensitive), then
 * a UNIQUE prefix/containment either way («трен» → «тренировка», «тренировочный»
 * → «тренировка» via the shared stem). Ambiguous resolves to null.
 */
export function findDayType(chatId: number, tgUserId: number, name: string): DayType | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const all = listDayTypes(chatId, tgUserId);
  const exact = all.filter((t) => t.name.toLowerCase() === n);
  if (exact.length === 1) return exact[0]!;
  const stem = (s: string) => s.slice(0, Math.max(4, Math.min(s.length, 5)));
  const loose = all.filter((t) => {
    const h = t.name.toLowerCase();
    return h.startsWith(n) || n.startsWith(h) || h.includes(n) || stem(h) === stem(n);
  });
  return loose.length === 1 ? loose[0]! : null;
}

export type UpsertDayTypeResult =
  | { status: 'created' | 'updated'; type: DayType }
  | { status: 'full'; max: number };

/** Create a type or update its goal (matched by exact name, case-insensitive). */
export function upsertDayType(
  chatId: number,
  tgUserId: number,
  name: string,
  goal: FoodGoal,
): UpsertDayTypeResult {
  const db = getDb();
  const clean = name.trim().replace(/\s+/g, ' ');
  const existing = listDayTypes(chatId, tgUserId).find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    db.prepare(
      'UPDATE food_day_type SET kcal = ?, protein = ?, fat = ?, carbs = ? WHERE id = ?',
    ).run(goal.kcal, goal.protein, goal.fat, goal.carbs, existing.id);
    return { status: 'updated', type: getDayTypeById(chatId, tgUserId, existing.id)! };
  }
  if (listDayTypes(chatId, tgUserId).length >= DAY_TYPES_MAX) {
    return { status: 'full', max: DAY_TYPES_MAX };
  }
  const info = db
    .prepare(
      `INSERT INTO food_day_type (chat_id, tg_user_id, name, kcal, protein, fat, carbs, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)`,
    )
    .run(chatId, tgUserId, clean, goal.kcal, goal.protein, goal.fat, goal.carbs);
  return { status: 'created', type: getDayTypeById(chatId, tgUserId, Number(info.lastInsertRowid))! };
}

/** Delete a type; days that pointed at it fall back to the default goal. */
export function deleteDayType(chatId: number, tgUserId: number, id: number): boolean {
  const db = getDb();
  let changed = false;
  db.transaction(() => {
    db.prepare('DELETE FROM food_day_kind WHERE chat_id = ? AND tg_user_id = ? AND type_id = ?').run(
      chatId,
      tgUserId,
      id,
    );
    changed =
      db.prepare('DELETE FROM food_day_type WHERE chat_id = ? AND tg_user_id = ? AND id = ?').run(
        chatId,
        tgUserId,
        id,
      ).changes > 0;
  })();
  return changed;
}

/** The type chosen for a day, or null (= default goal). */
export function getDayKind(chatId: number, tgUserId: number, localDate: string): DayType | null {
  const row = getDb()
    .prepare(
      `SELECT t.id, t.name, t.kcal, t.protein, t.fat, t.carbs
         FROM food_day_kind k JOIN food_day_type t ON t.id = k.type_id
        WHERE k.chat_id = ? AND k.tg_user_id = ? AND k.local_date = ?`,
    )
    .get(chatId, tgUserId, localDate) as DayTypeRow | undefined;
  return row ?? null;
}

/** Set a day's type; null returns the day to the default goal. */
export function setDayKind(chatId: number, tgUserId: number, localDate: string, typeId: number | null): void {
  const db = getDb();
  if (typeId === null) {
    db.prepare('DELETE FROM food_day_kind WHERE chat_id = ? AND tg_user_id = ? AND local_date = ?').run(
      chatId,
      tgUserId,
      localDate,
    );
    return;
  }
  db.prepare(
    `INSERT INTO food_day_kind (chat_id, tg_user_id, local_date, type_id, updated_at)
     VALUES (?, ?, ?, ?, unixepoch() * 1000)
     ON CONFLICT (chat_id, tg_user_id, local_date) DO UPDATE SET
       type_id = excluded.type_id, updated_at = excluded.updated_at`,
  ).run(chatId, tgUserId, localDate, typeId);
}

/** Day types over an inclusive range, keyed by date. */
export function listDayKinds(
  chatId: number,
  tgUserId: number,
  fromDate: string,
  toDate: string,
): Map<string, DayType> {
  const rows = getDb()
    .prepare(
      `SELECT k.local_date, t.id, t.name, t.kcal, t.protein, t.fat, t.carbs
         FROM food_day_kind k JOIN food_day_type t ON t.id = k.type_id
        WHERE k.chat_id = ? AND k.tg_user_id = ? AND k.local_date >= ? AND k.local_date <= ?`,
    )
    .all(chatId, tgUserId, fromDate, toDate) as (DayTypeRow & { local_date: string })[];
  return new Map(rows.map(({ local_date, ...t }) => [local_date, t]));
}
