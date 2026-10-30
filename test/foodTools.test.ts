import { describe, it, expect, vi, beforeEach } from 'vitest';

// Where the calorie diary tools are offered, that a log_food call reaches the
// handler, and that the sender's diary line rides in the context block — but not
// on turns where it could only mislead (the silent expense scan, spend-shaped turns).

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ADMIN_TELEGRAM_ID: '123',
};

let responses: unknown[] = [];
const createMock = vi.fn(async () => responses.shift());
vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

const text = (t: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: t }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
const tool = (name: string, input: Record<string, unknown>) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 't1', name, input }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

const logFood = vi.fn(() => ({
  write: { status: 'saved' as const, message: 'Записал еду в дневник.' },
  text: 'Записал: #1 Банан — 105 ккал. За сегодня всего: 105 ккал.',
  card: '| | ккал |\n|:--|--:|\n| · Банан | 105 |',
}));
const foodReport = vi.fn(() => ({ text: 'report', card: 'report-table' }));
const handlers = { logFood, foodReport } as unknown as Parameters<
  typeof import('../src/llm/assistant.js').runAssistant
>[1];

const ctx = (over: Record<string, unknown> = {}) => ({
  defaultCurrency: 'EUR',
  members: [],
  senderName: 'Tester',
  timezone: 'UTC',
  splidConnected: true,
  history: [],
  userContent: 'съел банан',
  ...over,
});

function call(i = -1) {
  const calls = createMock.mock.calls;
  return calls.at(i)![0] as {
    tools: { name?: string }[];
    system: { text: string }[];
    messages: { content: { type: string; text?: string }[] }[];
  };
}
const toolNames = () => call().tools.map((t) => t.name);
const contextText = () => call(0).messages.at(-1)!.content[0]!.text ?? '';

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  delete process.env.ENABLE_FOOD;
  vi.resetModules();
  createMock.mockClear();
  logFood.mockClear();
  responses = [];
});

const bananaInput = {
  action: 'add', items: [{ name: 'Банан', grams: 120, kcal: 105, protein: 1, fat: 0, carbs: 27 }],
  meal: null, date: null, entryIds: null, goal: null,
};

describe('write confirmations require execution', () => {
  it('does not replay a meal when asked why a past confirmation was false', async () => {
    responses = [text('Записал.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctx({ userContent: 'Почему ты сказал, что записал банан?' }), handlers);
    expect(logFood).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
  it('retries a fabricated confirmation and actually writes once', async () => {
    responses = [text('Записал.'), tool('log_food', bananaInput), text('Готово.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(ctx(), handlers);
    expect(logFood).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ text: 'Записал еду в дневник.', humorizable: false });
  });

  it('blocks repeated empty confirmations, including a report presented as a write', async () => {
    responses = [tool('food_report', { fromDate: null, toDate: null }), text('Поправил.'), text('Готово.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(ctx(), handlers);
    expect(logFood).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: expect.stringContaining('Дневник не изменён'), humorizable: false });
  });

  it('cannot reinterpret an unchanged/failed result as success', async () => {
    const { runAssistant } = await import('../src/llm/assistant.js');
    for (const status of ['unchanged', 'failed'] as const) {
      const message = status === 'unchanged' ? 'Значения уже совпадают — дневник не изменился.' : 'Не изменил дневник: запись не найдена.';
      logFood.mockReturnValueOnce({ text: message, card: null, write: { status, message } } as never);
      responses = [tool('log_food', { ...bananaInput, action: 'update', entryIds: [1] }), text('Исправил.')];
      expect(await runAssistant(ctx(), handlers)).toMatchObject({ text: message, humorizable: false });
    }
  });

  it('blocks a successful-looking reply after invalid input or database failure', async () => {
    const { runAssistant } = await import('../src/llm/assistant.js');
    responses = [tool('log_food', { action: 'add' }), text('Записал.')];
    const invalid = await runAssistant(ctx(), handlers);
    expect(logFood).not.toHaveBeenCalled();
    expect(invalid).toMatchObject({ text: expect.stringContaining('Не удалось подтвердить') });
    logFood.mockImplementationOnce(() => { throw new Error('database unavailable'); });
    responses = [tool('log_food', bananaInput), text('Готово.')];
    expect(await runAssistant(ctx(), handlers)).toMatchObject({ text: expect.stringContaining('Не удалось подтвердить') });
  });

  it('opens an old photo before update and forwards its image through the tool loop', async () => {
    const viewFoodPhoto = vi.fn(async () => [{ type: 'image', source: {
      type: 'base64', media_type: 'image/jpeg', data: 'abc',
    } }]);
    responses = [tool('view_food_photo', { entryId: 1 }),
      tool('log_food', { ...bananaInput, action: 'update', entryIds: [1] }), text('Готово.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctx({ userContent: 'перечитай фото и исправь' }), { ...handlers, viewFoodPhoto } as never);
    expect(viewFoodPhoto).toHaveBeenCalledWith({ entryId: 1 });
    expect(logFood).toHaveBeenCalledWith(expect.objectContaining({ action: 'update' }));
    expect(toolNames()).toContain('view_food_photo');
  });
});

describe('food tool exposure', () => {
  it('offers both tools in a normal chat', async () => {
    responses = [text('ok')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctx(), handlers);
    expect(toolNames()).toEqual(expect.arrayContaining(['log_food', 'food_report']));
  });

  it('hides them in tutor chats and on the silent expense-only scan', async () => {
    const { runAssistant } = await import('../src/llm/assistant.js');
    responses = [text('ok')];
    await runAssistant(ctx({ mode: 'tutor' }), handlers);
    expect(toolNames()).not.toContain('log_food');
    expect(toolNames()).not.toContain('food_report');

    responses = [text('')];
    await runAssistant(ctx({ expenseOnly: true }), handlers);
    expect(toolNames()).toEqual(['record_expense']);
  });

  it('scheduled/inline runs keep the read-only report but not the writer', async () => {
    responses = [text('ok')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctx({ allowFoodLog: false }), handlers);
    expect(toolNames()).not.toContain('log_food');
    expect(toolNames()).toContain('food_report');
  });

  it('ENABLE_FOOD=false removes both', async () => {
    process.env.ENABLE_FOOD = 'false';
    responses = [text('ok')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctx(), handlers);
    expect(toolNames()).not.toContain('log_food');
    expect(toolNames()).not.toContain('food_report');
  });
});

describe('food dispatch and context', () => {
  it('routes a log_food call to the handler and the result back to the model', async () => {
    const input = {
      action: 'add',
      items: [{ name: 'Банан', grams: 120, kcal: 105, protein: 1, fat: 0, carbs: 27 }],
      meal: 'snack',
      date: null,
      entryIds: null,
      goal: null,
    };
    responses = [tool('log_food', input), text('Записал банан, 105 ккал.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const res = await runAssistant(ctx(), handlers);
    expect(logFood).toHaveBeenCalledWith(input);
    // The table travels as a separate card (appended by the caller after the
    // tone passes), never inside the model's own words.
    expect(res).toMatchObject({
      kind: 'text',
      text: 'Записал еду в дневник.',
      humorizable: false,
      card: '| | ккал |\n|:--|--:|\n| · Банан | 105 |',
    });
    const second = call(-1).messages.at(-1)!.content[0] as unknown as { content: string };
    expect(second.content).toContain('За сегодня всего: 105 ккал');
  });

  it('carries the day-type button request out with the card', async () => {
    logFood.mockImplementationOnce(() => ({ text: 'ok', card: '|t|', dayTypePick: '2026-10-20',
      write: { status: 'saved', message: 'Записал еду в дневник.' } }) as never);
    responses = [
      tool('log_food', {
        action: 'add',
        items: [{ name: 'Банан', grams: 120, kcal: 105, protein: 1, fat: 0, carbs: 27 }],
        meal: null,
        date: null,
        entryIds: null,
        goal: null,
      }),
      text('Записал.'),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const res = await runAssistant(ctx(), handlers);
    expect(res).toMatchObject({ kind: 'text', card: '|t|', dayTypePick: '2026-10-20' });
  });

  it('a card-only turn (model said nothing) is still a reply, not «…»', async () => {
    responses = [tool('food_report', { fromDate: null, toDate: null }), text('')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const res = await runAssistant(ctx({ userContent: 'сколько я съел' }), handlers);
    expect(res).toMatchObject({ kind: 'text', text: '', card: 'report-table' });
  });

  it('carries the diary line on a normal turn, drops it on a spend-shaped one', async () => {
    const { runAssistant } = await import('../src/llm/assistant.js');
    const foodLine = 'Food diary of the sender, today 2026-09-29: 105 kcal: #1 Банан 105';
    responses = [text('ok')];
    await runAssistant(ctx({ foodLine }), handlers);
    expect(contextText()).toContain(foodLine);

    createMock.mockClear();
    responses = [text('ok')];
    await runAssistant(ctx({ foodLine, memoryFree: true }), handlers);
    expect(contextText()).not.toContain('Food diary');
  });

  it('the system prompt teaches the diary job and the food-photo rule', async () => {
    const { SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(SYSTEM_PROMPT).toContain('CALORIE DIARY');
    expect(SYSTEM_PROMPT).toContain('A photo of FOOD');
    expect(SYSTEM_PROMPT).toContain('ONE short clarifying question');
  });
});
