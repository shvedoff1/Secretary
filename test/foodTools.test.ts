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
      text: 'Записал банан, 105 ккал.',
      humorizable: false,
      card: '| | ккал |\n|:--|--:|\n| · Банан | 105 |',
    });
    const second = call(-1).messages.at(-1)!.content[0] as unknown as { content: string };
    expect(second.content).toContain('За сегодня всего: 105 ккал');
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
