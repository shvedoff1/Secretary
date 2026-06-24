import { describe, it, expect, vi, beforeEach } from 'vitest';

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ADMIN_TELEGRAM_ID: '123',
};

function setEnv(): void {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
}

// Queue of fake Anthropic responses; each runAssistant iteration shifts one.
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

function toolResponse(name: string, input: Record<string, unknown>) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function expenseInput(over: Record<string, unknown> = {}) {
  return {
    title: 'Чек',
    amount: 10,
    currency: 'EUR',
    payerHints: [],
    profiteerHints: [],
    splits: null,
    confidence: 0.9,
    notes: null,
    ...over,
  };
}

// A single assistant turn that emits one or more record_expense tool calls,
// optionally with a leading text block (the breakdown explanation).
function expenseResponse(
  inputs: Record<string, unknown>[],
  explanation?: string,
) {
  const content: unknown[] = [];
  if (explanation) content.push({ type: 'text', text: explanation });
  inputs.forEach((input, i) =>
    content.push({ type: 'tool_use', id: `exp-${i}`, name: 'record_expense', input }),
  );
  return { stop_reason: 'tool_use', content, usage: { input_tokens: 1, output_tokens: 1 } };
}

const handlers = {
  remember: () => 'Запомнил.',
  scheduleTask: () => 'ok',
  surfForecast: async () => 'forecast',
  addPoi: () => 'added',
};

function baseCtx(userContent: string) {
  return {
    defaultCurrency: 'EUR',
    members: [],
    memory: '',
    senderName: 'Tester',
    timezone: 'UTC',
    splidConnected: false,
    history: [],
    userContent,
  };
}

describe('runAssistant humorizable flag', () => {
  beforeEach(() => {
    setEnv();
    vi.resetModules();
    createMock.mockClear();
    responses = [];
  });

  it('marks a plain-chat answer (no tool used) as humorizable', async () => {
    responses = [textResponse('Привет!')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(baseCtx('привет'), handlers);

    expect(result).toEqual({ kind: 'text', text: 'Привет!', scheduled: false, humorizable: true });
  });

  it('does NOT mark a tool-driven answer as humorizable', async () => {
    // Model calls `remember`, then composes a final text reply.
    responses = [
      toolResponse('remember', { note: 'любит кофе' }),
      textResponse('Запомнил про кофе.'),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(baseCtx('запомни: люблю кофе'), handlers);

    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.humorizable).toBe(false);
    }
  });
});

describe('runAssistant expense extraction', () => {
  beforeEach(() => {
    setEnv();
    vi.resetModules();
    createMock.mockClear();
    responses = [];
  });

  const expenseCtx = { ...baseCtx('чек'), splidConnected: true };

  it('returns a single expense as a one-element inputs array', async () => {
    responses = [expenseResponse([expenseInput({ title: 'Такси', amount: 5 })])];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(expenseCtx, handlers);

    expect(result.kind).toBe('expense');
    if (result.kind === 'expense') {
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]!.title).toBe('Такси');
      expect(result.preamble).toBeNull();
    }
  });

  it('returns several per-group expenses from one turn, with the explanation as preamble', async () => {
    responses = [
      expenseResponse(
        [
          expenseInput({ title: 'Доширак + Спрайт', amount: 4, profiteerHints: ['Иван'] }),
          expenseInput({ title: 'Палки-вонялки', amount: 6, profiteerHints: ['Коля', 'Петя'] }),
        ],
        'Разбил чек на две траты: доширак со спрайтом на Ивана, палки на всех кроме Иры.',
      ),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(expenseCtx, handlers);

    expect(result.kind).toBe('expense');
    if (result.kind === 'expense') {
      expect(result.inputs).toHaveLength(2);
      expect(result.inputs.map((i) => i.title)).toEqual(['Доширак + Спрайт', 'Палки-вонялки']);
      expect(result.inputs[1]!.profiteerHints).toEqual(['Коля', 'Петя']);
      expect(result.preamble).toContain('две траты');
    }
  });

  it('skips an invalid expense call but keeps the valid ones', async () => {
    responses = [
      expenseResponse([
        expenseInput({ title: 'ok', amount: 3 }),
        // amount missing → fails Zod validation and is dropped.
        { title: 'broken', currency: 'EUR', payerHints: [], profiteerHints: [], splits: null, confidence: 0.5, notes: null },
      ]),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(expenseCtx, handlers);

    expect(result.kind).toBe('expense');
    if (result.kind === 'expense') {
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]!.title).toBe('ok');
    }
  });

  it('falls back to a text error when every expense call is invalid', async () => {
    responses = [
      expenseResponse([{ title: 'broken', currency: 'EUR' } as Record<string, unknown>]),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(expenseCtx, handlers);

    expect(result.kind).toBe('text');
  });
});
