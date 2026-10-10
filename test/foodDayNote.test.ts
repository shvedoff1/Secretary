import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DAY_NOTE_MAX,
  foodContextLine,
  mergeDayNote,
  renderDay,
  renderPeriod,
} from '../src/food/nutrition.js';
import { parseFoodArgs } from '../src/bot/commands/food.js';
import { LogFoodZ } from '../src/llm/schema.js';
import type { FoodEntry } from '../src/db/repos/food.repo.js';

// Day notes: a small free-text field per day («была тренировка») shown next to
// that day's numbers, so a spike reads with its reason.

const entry = (over: Partial<FoodEntry>): FoodEntry => ({
  id: 1,
  chatId: 1,
  tgUserId: 7,
  localDate: '2026-10-10',
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

describe('mergeDayNote', () => {
  it('appends by default, never duplicates, replaces only when asked', () => {
    expect(mergeDayNote(null, 'была тренировка', false)).toEqual({ text: 'была тренировка', cut: false });
    expect(mergeDayNote('была тренировка', 'ещё бегал', false).text).toBe('была тренировка; ещё бегал');
    expect(mergeDayNote('была тренировка; ещё бегал', 'Тренировка', false).text).toBe(
      'была тренировка; ещё бегал',
    );
    expect(mergeDayNote('была тренировка', 'день отдыха', true).text).toBe('день отдыха');
  });

  it('caps the field and reports the cut', () => {
    const r = mergeDayNote(null, 'а'.repeat(DAY_NOTE_MAX + 50), false);
    expect([...r.text]).toHaveLength(DAY_NOTE_MAX);
    expect(r.text.endsWith('…')).toBe(true);
    expect(r.cut).toBe(true);
  });
});

describe('rendering notes', () => {
  it('shows the note under the day title, also on an empty day', () => {
    const md = renderDay([entry({})], null, '2026-10-10', 'Сегодня', 'была тренировка');
    const lines = md.split('\n');
    expect(lines[0]).toContain('**Сегодня, сб 10.10**');
    expect(lines[1]).toBe('📝 была тренировка');
    expect(renderDay([], null, '2026-10-10', 'Сегодня', 'болел')).toContain('📝 болел');
    expect(renderDay([entry({})], null, '2026-10-10', 'Сегодня')).not.toContain('📝');
  });

  it('lists a period\'s notes under the table, in day order, and keeps the table narrow', () => {
    const notes = new Map([
      ['2026-10-09', 'ДР, торт'],
      ['2026-10-08', 'тренировка'],
    ]);
    const md = renderPeriod(
      [entry({ localDate: '2026-10-08' }), entry({ localDate: '2026-10-09' })],
      null,
      '2026-10-08',
      '2026-10-10',
      notes,
    );
    expect(md).toContain('| День | ккал | Б | Ж | У |');
    const tail = md.slice(md.lastIndexOf('|'));
    expect(tail).toMatch(/📝 чт 08\.10 — тренировка\n📝 пт 09\.10 — ДР, торт$/);
  });

  it('a period with only notes still shows them', () => {
    const md = renderPeriod([], null, '2026-10-08', '2026-10-10', new Map([['2026-10-09', 'болел']]));
    expect(md).toContain('ничего не записано');
    expect(md).toContain('📝 пт 09.10 — болел');
  });

  it('the context line carries the note, and a note alone is enough to show a day', () => {
    const line = foodContextLine(
      [
        { label: 'today', date: '2026-10-10', entries: [], note: 'была тренировка' },
        { label: 'yesterday', date: '2026-10-09', entries: [], note: null },
      ],
      null,
    )!;
    expect(line).toContain('day note: «была тренировка»');
  });
});

describe('/food note and the tool schema', () => {
  const today = '2026-10-10';

  it('parses today, a dated note and a clear', () => {
    expect(parseFoodArgs('note была тренировка', today)).toEqual({
      kind: 'note',
      date: today,
      text: 'была тренировка',
    });
    expect(parseFoodArgs('заметка 08.10 Болел', today)).toEqual({ kind: 'note', date: '2026-10-08', text: 'Болел' });
    expect(parseFoodArgs('note clear', today)).toEqual({ kind: 'note', date: today, text: null });
    expect(parseFoodArgs('note 08.10 удали', today)).toEqual({ kind: 'note', date: '2026-10-08', text: null });
    expect(parseFoodArgs('note', today)).toEqual({ kind: 'help' });
  });

  it('log_food accepts the note action (and old inputs without the new fields)', () => {
    const base = { items: null, meal: null, date: null, entryIds: null, goal: null };
    expect(LogFoodZ.safeParse({ ...base, action: 'note', note: 'тренировка', noteReplace: null }).success).toBe(true);
    expect(LogFoodZ.safeParse({ ...base, action: 'remove', entryIds: [1] }).success).toBe(true);
  });
});

// --- handler + repo (in-memory DB) ------------------------------------------

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
  return { food, repo };
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

const NOW = () => Date.UTC(2026, 9, 10, 12, 0);
const note = (text: string | null, over: Record<string, unknown> = {}) => ({
  action: 'note' as const,
  items: null,
  meal: null,
  date: null,
  entryIds: null,
  goal: null,
  note: text,
  noteReplace: null,
  ...over,
});

describe('log_food note', () => {
  it('sets, appends, replaces and clears a day\'s note, showing the day card', async () => {
    const { food, repo } = await load();
    const log = food.makeLogFoodHandler(-100, 7, NOW);

    const r1 = log(note('была тренировка'));
    expect(r1.text).toContain('«была тренировка»');
    expect(r1.card).toContain('📝 была тренировка');

    log(note('ещё бегал 5 км'));
    expect(repo.getDayNote(-100, 7, '2026-10-10')).toBe('была тренировка; ещё бегал 5 км');

    log(note('день отдыха', { noteReplace: true }));
    expect(repo.getDayNote(-100, 7, '2026-10-10')).toBe('день отдыха');

    const cleared = log(note(''));
    expect(cleared.text).toContain('убрал');
    expect(repo.getDayNote(-100, 7, '2026-10-10')).toBeNull();
  });

  it('targets a past day, clamps a future one, and stays personal', async () => {
    const { food, repo } = await load();
    food.makeLogFoodHandler(-100, 7, NOW)(note('ДР', { date: '2026-10-09' }));
    food.makeLogFoodHandler(-100, 7, NOW)(note('завтра пицца', { date: '2026-10-11' }));
    expect(repo.getDayNote(-100, 7, '2026-10-09')).toBe('ДР');
    expect(repo.getDayNote(-100, 7, '2026-10-10')).toBe('завтра пицца');
    expect(repo.getDayNote(-100, 8, '2026-10-09')).toBeNull();
  });

  it('notes reach the period report and the context line', async () => {
    const { food } = await load();
    food.makeLogFoodHandler(-100, 7, NOW)(note('тренировка', { date: '2026-10-08' }));
    const week = food.makeFoodReportHandler(-100, 7, NOW)({ fromDate: '2026-10-04', toDate: '2026-10-10' });
    expect(week.card).toContain('📝 чт 08.10 — тренировка');

    food.makeLogFoodHandler(-100, 7, NOW)(note('болею'));
    expect(food.foodContextFor(-100, 7, NOW())).toContain('day note: «болею»');
  });
});
