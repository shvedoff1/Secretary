import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const now = () => Date.UTC(2026, 9, 30, 10);
let close: (() => void) | undefined;
beforeEach(() => {
  Object.assign(process.env, { BOT_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', ADMIN_TELEGRAM_ID: '1',
    DATABASE_PATH: ':memory:', DEFAULT_TIMEZONE: 'UTC' });
  vi.resetModules();
});
afterEach(() => close?.());
async function setup() {
  const db = await import('../src/db/client.js');
  close = db.closeDb;
  (await import('../src/db/migrate.js')).migrate();
  return { db: db.getDb(), repo: await import('../src/db/repos/food.repo.js'),
    food: await import('../src/food/handler.js') };
}
const pancake = { name: 'Блинчики с матчей', grams: 140, kcal: 263.34,
  protein: 5.74, fat: 13.58, carbs: 29.54 };
const base = { action: 'add' as const, items: [pancake], date: null, meal: null,
  entryIds: null, match: null, goal: null };
const source = { fileId: 'telegram-photo', mediaType: 'image/jpeg' as const };

describe('atomic diary corrections and write receipts', () => {
  it('keeps id, yesterday, meal and photo; per-portion 263.34 is not multiplied by 140 g', async () => {
    const { food, repo } = await setup();
    food.makeLogFoodHandler(7, 7, now, source)({ ...base, date: '2026-10-29', meal: 'dinner',
      items: [{ ...pancake, kcal: 500 }] });
    const before = repo.lastFoodEntry(7, 7)!;
    const result = food.makeLogFoodHandler(7, 7, now)({ ...base, action: 'update', entryIds: [before.id] });
    expect(result.write?.status).toBe('saved');
    expect(repo.lastFoodEntry(7, 7)).toMatchObject({ id: before.id, localDate: '2026-10-29',
      meal: 'dinner', source, grams: 140, kcal: 263, protein: 5.7, fat: 13.6, carbs: 29.5 });
    expect(repo.listFoodEntries(7, 7, '2026-10-30', '2026-10-30')).toEqual([]);
    expect(result.card).toContain('263');
    expect(food.foodContextFor(7, 7, now())).toContain('view_food_photo');
  });

  it('reports already equal values as unchanged, not corrected', async () => {
    const { food, repo } = await setup();
    const log = food.makeLogFoodHandler(7, 7, now);
    log(base);
    const result = log({ ...base, action: 'update', entryIds: [repo.lastFoodEntry(7, 7)!.id] });
    expect(result.write).toMatchObject({ status: 'unchanged' });
    expect(result.write?.message).toContain('не изменился');
  });

  it('does not touch ambiguous or other users/chat entries', async () => {
    const { food, repo } = await setup();
    const log = food.makeLogFoodHandler(7, 7, now);
    log({ ...base, items: [pancake, pancake] });
    const before = repo.listFoodEntries(7, 7, '2026-10-30', '2026-10-30');
    expect(log({ ...base, action: 'update', match: ['блинчики'] }).write?.status).toBe('failed');
    expect(repo.listFoodEntries(7, 7, '2026-10-30', '2026-10-30')).toEqual(before);
    expect(food.makeLogFoodHandler(7, 8, now)({ ...base, action: 'update', entryIds: [before[0]!.id] }).write?.status).toBe('failed');
    expect(repo.updateFoodEntry(8, 7, before[0]!.id, pancake)).toBeNull();
    expect(repo.getFoodEntry(7, 7, before[0]!.id)).toEqual(before[0]);
  });

  it('rolls back when SQLite rejects an update or read-back differs', async () => {
    const { db, food, repo } = await setup();
    const log = food.makeLogFoodHandler(7, 7, now);
    log(base);
    const before = repo.lastFoodEntry(7, 7)!;
    db.exec(`CREATE TRIGGER corrupt_food AFTER UPDATE ON food_entry BEGIN
      UPDATE food_entry SET kcal = 999 WHERE id = NEW.id; END`);
    expect(() => repo.updateFoodEntry(7, 7, before.id, { ...pancake, kcal: 300 })).toThrow('read-back');
    expect(repo.getFoodEntry(7, 7, before.id)).toEqual(before);
  });

  it('rolls back the entire meal if insert read-back fails', async () => {
    const { db, repo } = await setup();
    db.exec(`CREATE TRIGGER corrupt_food AFTER INSERT ON food_entry BEGIN
      UPDATE food_entry SET kcal = 999 WHERE id = NEW.id; END`);
    expect(() => repo.addFoodEntries({ chatId: 7, tgUserId: 7, localDate: '2026-10-30',
      meal: 'lunch', items: [pancake, pancake] })).toThrow('read-back');
    expect(repo.lastFoodEntry(7, 7)).toBeNull();
  });
});
