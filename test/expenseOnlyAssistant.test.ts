import { describe, it, expect, vi, beforeEach } from 'vitest';

// The expense-only shape of runAssistant: the silent auto-expense scan (an
// unaddressed message that just looks like a spend) can only record an expense or
// produce nothing, so it gets `record_expense` and nothing else — no memory in the
// context block, and no tool that could quietly WRITE (remember / set_rule /
// schedule_task) on a message nobody sent to the bot.

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

function textResponse(text: string) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const handlers = {
  remember: () => 'Запомнил.',
  editMemory: () => 'Поправил.',
  editPingList: () => 'ok',
  setRule: () => 'ok',
  scheduleTask: () => 'ok',
  surfForecast: async () => 'forecast',
  addPoi: () => 'added',
  spendingReport: async () => 'report',
};

function ctxFor(over: Record<string, unknown> = {}) {
  return {
    defaultCurrency: 'EUR',
    members: [{ name: 'Андрей Шведов' }, { name: 'Иван' }],
    senderName: 'Андрей Шведов',
    timezone: 'UTC',
    splidConnected: true,
    memoryChat: [{ content: 'едем на Бали в марте' }],
    memoryUsers: [{ subject: 'Андрей Шведов', items: [{ content: 'Швед — это я' }] }],
    memoryPersona: [{ content: 'зовите его Шведом' }],
    memoryTotal: 42,
    activeReminders: [{ id: 1, title: 'встать', when: 'завтра' }],
    activeWatches: [{ id: 2, title: 'сеансы', url: 'https://x.test' }],
    places: [{ name: 'Кафе', category: 'cafe' }],
    history: [],
    userContent: 'круассан 50 Ивану',
    ...over,
  };
}

function lastCall() {
  return createMock.mock.calls[createMock.mock.calls.length - 1]![0] as {
    tools: { name?: string }[];
    messages: { role: string; content: { type: string; text?: string }[] }[];
  };
}

/** The context block is always the first text block of the current user message. */
function contextBlock(): string {
  const msgs = lastCall().messages;
  return msgs[msgs.length - 1]!.content[0]!.text!;
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  vi.resetModules();
  createMock.mockClear();
  responses = [];
});

describe('runAssistant expense-only scan', () => {
  it('offers record_expense and nothing else', async () => {
    responses = [textResponse('ничего')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor({ expenseOnly: true }), handlers);

    expect(lastCall().tools.map((t) => t.name)).toEqual(['record_expense']);
  });

  it('sends no memory (nor reminders/watches/places) in the context block', async () => {
    responses = [textResponse('ничего')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor({ expenseOnly: true }), handlers);

    const block = contextBlock();
    expect(block).not.toContain('Chat memory');
    expect(block).not.toContain('About Андрей Шведов');
    expect(block).not.toContain('Швед — это я');
    expect(block).not.toContain('Voice & style');
    expect(block).not.toContain('Memory store');
    expect(block).not.toContain('Active reminders');
    expect(block).not.toContain('Active page watches');
    expect(block).not.toContain('Saved places');
    // What an expense actually needs is still there.
    expect(block).toContain('Message sender: Андрей Шведов');
    expect(block).toContain('Group members: Андрей Шведов, Иван');
    expect(block).toContain('Chat default currency: EUR');
  });

  it('keeps the chat’s standing rules — they are orders, not context', async () => {
    responses = [textResponse('ничего')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(
      ctxFor({ expenseOnly: true, rules: ['отвечай короче'] }),
      handlers,
    );

    expect(contextBlock()).toContain('отвечай короче');
  });

  it('does not cut the toolset when no Splid group is connected (never an empty list)', async () => {
    responses = [textResponse('ничего')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor({ expenseOnly: true, splidConnected: false }), handlers);

    const names = lastCall().tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain('remember');
  });

  it('leaves a normal (addressed) turn untouched: full toolset and full memory', async () => {
    responses = [textResponse('ок')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor(), handlers);

    const names = lastCall().tools.map((t) => t.name);
    expect(names).toContain('record_expense');
    expect(names).toContain('remember');
    expect(names).toContain('recall_memory');

    const block = contextBlock();
    expect(block).toContain('Chat memory');
    expect(block).toContain('About Андрей Шведов');
    expect(block).toContain('Active reminders');
  });

  it('tells the model how much memory is hidden behind recall_memory', async () => {
    responses = [textResponse('ок')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor(), handlers);

    // 42 stored, 3 shown → the depth hint must reach the secretary context block
    // (it used to be built without memoryTotal, so the hint never rendered).
    expect(contextBlock()).toContain('Memory store: 42 facts total, 3 shown above');
  });
});
