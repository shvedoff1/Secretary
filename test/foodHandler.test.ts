import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The calorie diary handlers: the model hands over per-item ESTIMATES, and
// everything else — which chat-local day it lands on, whose diary it is, the
// running total the reply quotes — is decided here.

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.DEFAULT_TIMEZONE = 'UTC';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const food = await import('../src/food/handler.js');
  const repo = await import('../src/db/repos/food.repo.js');
  const settings = await import('../src/db/repos/chatSettings.repo.js');
  return { food, repo, settings };
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

// 2026-09-29 10:00 UTC
const NOON = Date.UTC(2026, 8, 29, 10, 0);
const now = () => NOON;

const item = (name: string, kcal: number, over: Record<string, unknown> = {}) => ({
  name,
  grams: null,
  kcal,
  protein: null,
  fat: null,
  carbs: null,
  ...over,
});

const add = (items: ReturnType<typeof item>[], over: Record<string, unknown> = {}) => ({
  action: 'add' as const,
  items,
  meal: 'lunch' as const,
  date: null,
  entryIds: null,
  goal: null,
  ...over,
});

describe('log_food add', () => {
  it('stores each item for the sender today and quotes the deterministic total', async () => {
    const { food, repo } = await load();
    const log = food.makeLogFoodHandler(-100, 7, now);
    const out = log(
      add([
        item('Борщ', 250.4, { grams: 350, protein: 10, fat: 12, carbs: 25 }),
        item('Хлеб', 80),
      ]),
    );
    const rows = repo.listFoodEntries(-100, 7, '2026-09-29', '2026-09-29');
    expect(rows.map((r) => [r.name, r.kcal, r.meal])).toEqual([
      ['Борщ', 250, 'lunch'],
      ['Хлеб', 80, 'lunch'],
    ]);
    expect(out).toContain(`#${rows[0]!.id} Борщ (350 г) — 250 ккал · Б 10 · Ж 12 · У 25`);
    // An item with no macro estimate says so instead of pretending zeros.
    expect(out).toContain(`#${rows[1]!.id} Хлеб — 80 ккал.`);
    // БЖУ for the meal and for the whole day, not just calories.
    expect(out).toContain('За приём: 330 ккал · Б 10 · Ж 12 · У 25 г');
    expect(out).toMatch(/За сегодня всего: 330 ккал, Б 10 · Ж 12 · У 25 г/);
    expect(out).toContain('За приём: 330 ккал');
    expect(out).toContain('За сегодня всего: 330 ккал');
    expect(out).toContain('Цели по калориям нет');

    // A second meal adds to the same day's total.
    const out2 = log(add([item('Яблоко', 70)], { meal: 'snack' }));
    expect(out2).toContain('За сегодня всего: 400 ккал');
  });

  it('keeps diaries personal: another sender in the same group starts from zero', async () => {
    const { food } = await load();
    food.makeLogFoodHandler(-100, 7, now)(add([item('Пицца', 800)]));
    const out = food.makeLogFoodHandler(-100, 8, now)(add([item('Салат', 150)]));
    expect(out).toContain('всего: 150 ккал');
  });

  it('files the entry under the CHAT-LOCAL day', async () => {
    const { food, repo, settings } = await load();
    settings.setTimezone(-100, 'Asia/Ho_Chi_Minh'); // UTC+7
    // 20:00 UTC on the 29th is already 03:00 on the 30th in Vietnam.
    const late = () => Date.UTC(2026, 8, 29, 20, 0);
    food.makeLogFoodHandler(-100, 7, late)(add([item('Фо', 450)]));
    expect(repo.listFoodEntries(-100, 7, '2026-09-30', '2026-09-30')).toHaveLength(1);
  });

  it('honours a past date («вчера на ужин») but clamps a future one to today', async () => {
    const { food, repo } = await load();
    const log = food.makeLogFoodHandler(-100, 7, now);
    log(add([item('Плов', 600)], { date: '2026-09-28' }));
    log(add([item('Торт', 400)], { date: '2026-10-05' }));
    expect(repo.listFoodEntries(-100, 7, '2026-09-28', '2026-09-28')[0]!.name).toBe('Плов');
    expect(repo.listFoodEntries(-100, 7, '2026-09-29', '2026-09-29')[0]!.name).toBe('Торт');
  });

  it('shows progress against the goal once one is set', async () => {
    const { food } = await load();
    const log = food.makeLogFoodHandler(-100, 7, now);
    const goalOut = log({
      action: 'set_goal',
      items: null,
      meal: null,
      date: null,
      entryIds: null,
      goal: { kcal: 2000, protein: 120, fat: null, carbs: null },
    });
    expect(goalOut).toContain('Цель записана: 2 000 ккал');
    const out = log(add([item('Гречка', 500)]));
    expect(out).toContain('500 / 2 000 ккал');
    // Macro goals show as progress too: protein has a target, fat/carbs don't.
    expect(out).toContain('Б 0/120 · Ж 0 · У 0 г');
    expect(out).toContain('осталось 1 500');
  });
});

describe('log_food remove / set_goal clear', () => {
  it('removes only the sender\'s own entries and re-totals the day', async () => {
    const { food, repo } = await load();
    const mine = food.makeLogFoodHandler(-100, 7, now);
    mine(add([item('Кофе', 120), item('Круассан', 300)]));
    const theirs = food.makeLogFoodHandler(-100, 8, now);
    theirs(add([item('Чай', 5)]));
    const [coffee] = repo.listFoodEntries(-100, 7, '2026-09-29', '2026-09-29');
    const [tea] = repo.listFoodEntries(-100, 8, '2026-09-29', '2026-09-29');

    const out = mine({ ...add([]), action: 'remove', items: null, entryIds: [coffee!.id, tea!.id] });
    expect(out).toContain(`Удалил: #${coffee!.id} Кофе`);
    expect(out).toContain('300 ккал');
    expect(repo.listFoodEntries(-100, 8, '2026-09-29', '2026-09-29')).toHaveLength(1);

    const miss = mine({ ...add([]), action: 'remove', items: null, entryIds: [tea!.id] });
    expect(miss).toContain('ничего не удалил');
  });

  it('a zero goal clears it', async () => {
    const { food, repo } = await load();
    const log = food.makeLogFoodHandler(-100, 7, now);
    const set = (kcal: number) =>
      log({ ...add([]), action: 'set_goal', items: null, goal: { kcal, protein: null, fat: null, carbs: null } });
    set(1800);
    expect(repo.getFoodGoal(-100, 7)?.kcal).toBe(1800);
    expect(set(0)).toContain('снята');
    expect(repo.getFoodGoal(-100, 7)).toBeNull();
  });
});

describe('food_report', () => {
  it('renders today by default and a range as statistics', async () => {
    const { food } = await load();
    const log = food.makeLogFoodHandler(-100, 7, now);
    log(add([item('Суп', 300)], { date: '2026-09-27' }));
    log(add([item('Каша', 400)]));
    const report = food.makeFoodReportHandler(-100, 7, now);

    const today = report({ fromDate: null, toDate: null });
    expect(today).toContain('Сегодня');
    expect(today).toContain('Каша');
    expect(today).not.toContain('Суп');

    const week = report({ fromDate: '2026-09-23', toDate: '2026-09-29' });
    expect(week).toContain('вс 27.09 — 300 ккал');
    expect(week).toContain('В среднем за 2 дн. с записями: 350 ккал');
  });

  it('never reports into the future and fixes a reversed range', async () => {
    const { food } = await load();
    const report = food.makeFoodReportHandler(-100, 7, now);
    const out = report({ fromDate: '2026-10-03', toDate: '2026-09-28' });
    expect(out).toContain('28.09–29.09');
  });

  it('context line appears only once there is something to show', async () => {
    const { food } = await load();
    expect(food.foodContextFor(-100, 7, NOON)).toBeNull();
    food.makeLogFoodHandler(-100, 7, now)(add([item('Банан', 105)]));
    expect(food.foodContextFor(-100, 7, NOON)).toContain('Банан 105');
  });
});
