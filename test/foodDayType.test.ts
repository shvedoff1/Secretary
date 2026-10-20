import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderDay, renderPeriod, foodContextLine, dayTypeTag } from '../src/food/nutrition.js';
import { dayTypeKeyboard, DAY_TYPE_CALLBACK_RE } from '../src/food/dayTypeKeyboard.js';
import { parseFoodArgs } from '../src/bot/commands/food.js';
import { LogFoodZ } from '../src/llm/schema.js';
import type { FoodEntry } from '../src/db/repos/food.repo.js';

// Day types: a training day and a rest day want different КБЖУ targets. Each
// day is judged against ITS type's goal, the type is asked with buttons on the
// first entry of a day, and it can be changed later in words or with /food day.

const entry = (over: Partial<FoodEntry>): FoodEntry => ({
  id: 1,
  chatId: 1,
  tgUserId: 1,
  localDate: '2026-10-20',
  meal: 'lunch',
  name: 'Еда',
  grams: null,
  kcal: 500,
  protein: 30,
  fat: 20,
  carbs: 50,
  createdAt: 0,
  ...over,
});
const train = { name: 'тренировка', kcal: 2600, protein: 180, fat: 70, carbs: 300 };
const rest = { name: 'отдых', kcal: 2000, protein: 150, fat: 60, carbs: 200 };

describe('rendering with day types', () => {
  it('names the type in the day title and measures against its goal', () => {
    const md = renderDay([entry({ kcal: 1300 })], train, '2026-10-20', 'Сегодня', null, 'тренировка');
    expect(md).toContain('**Сегодня, вт 20.10** · Тренировка · 1 300 из 2 600 ккал');
    expect(md).toContain('| Цель | 2 600 | 180 | 70 | 300 |');
  });

  it('judges each day of a period by its own goal; mixed goals drop the single Цель row', () => {
    const md = renderPeriod(
      [entry({ localDate: '2026-10-19', kcal: 2400 }), entry({ localDate: '2026-10-20', kcal: 2400 })],
      null,
      '2026-10-19',
      '2026-10-20',
      new Map(),
      new Map([
        ['2026-10-19', train],
        ['2026-10-20', rest],
      ]),
    );
    expect(md).toContain('| пн 19.10 трен | 2 400 |'); // under 2600 — no ↑
    expect(md).toContain('| вт 20.10 отды | 2 400 ↑ |'); // over 2000
    expect(md).not.toContain('| Цель |');
    expect(md).toContain('в цель по ккал: 1 из 2');
    expect(md).toContain('цель у каждого дня своя');
    expect(md).toContain('типы: трен — тренировка, отды — отдых');
  });

  it('untyped days fall back to the default goal; a uniform goal keeps the Цель row', () => {
    const def = { kcal: 2200, protein: null, fat: null, carbs: null };
    const md = renderPeriod(
      [entry({ localDate: '2026-10-19', kcal: 2000 }), entry({ localDate: '2026-10-20', kcal: 2300 })],
      def,
      '2026-10-19',
      '2026-10-20',
    );
    expect(md).toContain('| Цель | 2 200 |');
    expect(md).toContain('| вт 20.10 | 2 300 ↑ |');
    expect(dayTypeTag('Тренировка')).toBe('трен');
  });

  it('the context line carries the day type and the list of types', () => {
    const line = foodContextLine(
      [{ label: 'today', date: '2026-10-20', entries: [], dayType: rest }],
      null,
      12,
      [train, rest],
    )!;
    expect(line).toContain('today 2026-10-20 [day type: отдых]');
    expect(line).toContain('of goal 2 000 kcal');
    expect(line).toContain('Day types (log_food set_day_type): тренировка 2 600 kcal; отдых 2 000 kcal');
  });
});

describe('day-type buttons and /food grammar', () => {
  it('lays out one button per type, two per row, plus «Обычный», marking the current one', () => {
    const kb = dayTypeKeyboard(
      [
        { id: 3, ...train },
        { id: 4, ...rest },
        { id: 5, name: 'болезнь', kcal: 1800, protein: null, fat: null, carbs: null },
      ],
      '2026-10-20',
      4,
    );
    const rows = kb.inline_keyboard.map((r) => r.map((b) => ('callback_data' in b ? b.callback_data : '')));
    expect(rows).toEqual([['fdt:2026-10-20:3', 'fdt:2026-10-20:4'], ['fdt:2026-10-20:5'], ['fdt:2026-10-20:0']]);
    expect(kb.inline_keyboard[0]![1]!.text).toBe('✓ Отдых');
    expect(DAY_TYPE_CALLBACK_RE.exec('fdt:2026-10-20:4')?.slice(1)).toEqual(['2026-10-20', '4']);
  });

  it('parses types / type add / type del / day', () => {
    const today = '2026-10-20';
    expect(parseFoodArgs('types', today)).toEqual({ kind: 'types' });
    expect(parseFoodArgs('type add тренировка 2600 [180 70 300]', today)).toEqual({
      kind: 'type_set',
      name: 'тренировка',
      kcal: 2600,
      protein: 180,
      fat: 70,
      carbs: 300,
    });
    expect(parseFoodArgs('тип день отдыха 2200', today)).toMatchObject({ kind: 'type_set', name: 'день отдыха', kcal: 2200 });
    expect(parseFoodArgs('type del отдых', today)).toEqual({ kind: 'type_del', name: 'отдых' });
    expect(parseFoodArgs('type add тренировка', today)).toEqual({ kind: 'help' });
    expect(parseFoodArgs('day', today)).toEqual({ kind: 'day_pick', date: today });
    expect(parseFoodArgs('day отдых', today)).toEqual({ kind: 'day_set', date: today, name: 'отдых' });
    expect(parseFoodArgs('day 19.10 тренировка', today)).toEqual({ kind: 'day_set', date: '2026-10-19', name: 'тренировка' });
    expect(parseFoodArgs('day обычный', today)).toEqual({ kind: 'day_set', date: today, name: null });
    expect(parseFoodArgs('day 19.10', today)).toEqual({ kind: 'day_pick', date: '2026-10-19' });
  });

  it('log_food accepts the new action and field', () => {
    const base = { items: null, meal: null, date: null, entryIds: null, goal: null };
    expect(LogFoodZ.safeParse({ ...base, action: 'set_day_type', dayType: 'отдых' }).success).toBe(true);
  });
});

// --- with a real DB ----------------------------------------------------------

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.DEFAULT_TIMEZONE = 'UTC';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    food: await import('../src/food/handler.js'),
    repo: await import('../src/db/repos/food.repo.js'),
  };
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

const DM = 4242;
const NOW = () => Date.UTC(2026, 9, 20, 12, 0);
const base = { items: null, meal: null, date: null, entryIds: null, goal: null } as const;
const goal = (kcal: number, protein: number | null = null) => ({ kcal, protein, fat: null, carbs: null });
const add = (kcal: number, over: Record<string, unknown> = {}) => ({
  ...base,
  action: 'add' as const,
  items: [{ name: 'Еда', grams: null, kcal, protein: 10, fat: 10, carbs: 10 }],
  ...over,
});

describe('day types: repo + handler', () => {
  it('set_goal with dayType creates/updates a type; 0 kcal deletes it and its days fall back', async () => {
    const { food, repo } = await load();
    const log = food.makeLogFoodHandler(DM, DM, NOW);
    expect(log({ ...base, action: 'set_goal', goal: goal(2600, 180), dayType: 'тренировка' }).text).toContain('создан');
    expect(log({ ...base, action: 'set_goal', goal: goal(2700, 180), dayType: 'Тренировка' }).text).toContain('обновлён');
    expect(repo.listDayTypes(DM, DM).map((t) => [t.name, t.kcal])).toEqual([['тренировка', 2700]]);

    log({ ...base, action: 'set_day_type', dayType: 'трен' });
    expect(repo.getDayKind(DM, DM, '2026-10-20')?.name).toBe('тренировка');

    log({ ...base, action: 'set_goal', goal: goal(0), dayType: 'тренировка' });
    expect(repo.listDayTypes(DM, DM)).toEqual([]);
    expect(repo.getDayKind(DM, DM, '2026-10-20')).toBeNull();
  });

  it('asks for the type on the FIRST entry of an untyped day only, and only when types exist', async () => {
    const { food, repo } = await load();
    const log = food.makeLogFoodHandler(DM, DM, NOW);
    expect(log(add(300)).dayTypePick).toBeUndefined(); // no types defined

    repo.upsertDayType(DM, DM, 'тренировка', goal(2600));
    expect(log(add(300, { date: '2026-10-19' })).dayTypePick).toBe('2026-10-19'); // first entry that day
    expect(log(add(300, { date: '2026-10-19' })).dayTypePick).toBeUndefined(); // second entry

    const t = repo.findDayType(DM, DM, 'тренировка')!;
    repo.setDayKind(DM, DM, '2026-10-18', t.id);
    expect(log(add(300, { date: '2026-10-18' })).dayTypePick).toBeUndefined(); // type already chosen
  });

  it('a day\'s totals and card use its type\'s goal; set_day_type null returns to the default', async () => {
    const { food, repo } = await load();
    repo.setFoodGoal(DM, DM, goal(2000));
    repo.upsertDayType(DM, DM, 'тренировка', goal(2600));
    const log = food.makeLogFoodHandler(DM, DM, NOW);
    log({ ...base, action: 'set_day_type', dayType: 'тренировка' });
    const res = log(add(1300));
    expect(res.text).toContain('1 300 / 2 600 ккал');
    expect(res.card).toContain('· Тренировка · 1 300 из 2 600 ккал');

    const back = log({ ...base, action: 'set_day_type', dayType: null });
    expect(back.card).toContain('1 300 из 2 000 ккал');
  });

  it('an unknown type is reported with the list, nothing changes', async () => {
    const { food, repo } = await load();
    repo.upsertDayType(DM, DM, 'тренировка', goal(2600));
    const out = food.makeLogFoodHandler(DM, DM, NOW)({ ...base, action: 'set_day_type', dayType: 'праздник' });
    expect(out.text).toContain('Есть: тренировка');
    expect(repo.getDayKind(DM, DM, '2026-10-20')).toBeNull();
  });

  it('types are capped', async () => {
    const { repo } = await load();
    for (let i = 0; i < repo.DAY_TYPES_MAX; i++) repo.upsertDayType(DM, DM, `тип${i}`, goal(2000));
    expect(repo.upsertDayType(DM, DM, 'лишний', goal(2000))).toEqual({ status: 'full', max: repo.DAY_TYPES_MAX });
  });
});

describe('day-type button tap', () => {
  const tap = (chatId: number, fromId: number, data: string) => {
    const answerCallbackQuery = vi.fn(async () => true);
    const editMessageReplyMarkup = vi.fn(async () => true);
    const sendRichMessage = vi.fn(async () => ({}));
    const ctx = {
      chat: { id: chatId },
      from: { id: fromId },
      callbackQuery: { data },
      answerCallbackQuery,
      editMessageReplyMarkup,
      api: { sendRichMessage },
    };
    return { ctx, answerCallbackQuery, editMessageReplyMarkup, sendRichMessage };
  };

  it('sets the day type, clears the buttons and re-sends the day card', async () => {
    const { repo } = await load();
    const t = repo.upsertDayType(DM, DM, 'отдых', goal(2000));
    if (t.status === 'full') throw new Error('unreachable');
    const { handleDayTypeCallback } = await import('../src/bot/handlers/onFoodDayType.js');
    const h = tap(DM, DM, `fdt:2026-10-20:${t.type.id}`);
    await handleDayTypeCallback(h.ctx as never);
    expect(repo.getDayKind(DM, DM, '2026-10-20')?.name).toBe('отдых');
    expect(h.answerCallbackQuery).toHaveBeenCalledWith({ text: 'День: отдых' });
    expect(h.editMessageReplyMarkup).toHaveBeenCalled();
    expect(JSON.stringify(h.sendRichMessage.mock.calls[0])).toContain('Отдых');
  });

  it('«Обычный» clears the type; taps outside the owner\'s DM do nothing', async () => {
    const { repo } = await load();
    const t = repo.upsertDayType(DM, DM, 'отдых', goal(2000));
    if (t.status === 'full') throw new Error('unreachable');
    repo.setDayKind(DM, DM, '2026-10-20', t.type.id);
    const { handleDayTypeCallback } = await import('../src/bot/handlers/onFoodDayType.js');

    const group = tap(-100, DM, 'fdt:2026-10-20:0');
    await handleDayTypeCallback(group.ctx as never);
    expect(repo.getDayKind(DM, DM, '2026-10-20')?.name).toBe('отдых');

    await handleDayTypeCallback(tap(DM, DM, 'fdt:2026-10-20:0').ctx as never);
    expect(repo.getDayKind(DM, DM, '2026-10-20')).toBeNull();
  });
});
