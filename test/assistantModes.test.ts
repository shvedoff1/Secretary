import { describe, it, expect, vi, beforeEach } from 'vitest';

// How the chat's MODE and its RULES reach the model: which system prompt is
// cached as the prefix, which tools are offered, and that the standing rules are
// in the context block of the very turn they were set in.

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

function toolResponse(name: string, input: Record<string, unknown>) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const setRuleMock = vi.fn(() => 'Записал правило.');

const handlers = {
  remember: () => 'Запомнил.',
  editMemory: () => 'Поправил.',
  editPingList: () => 'ok',
  setRule: setRuleMock,
  scheduleTask: () => 'ok',
  surfForecast: async () => 'forecast',
  addPoi: () => 'added',
  spendingReport: async () => 'report',
};

function ctxFor(over: Record<string, unknown> = {}) {
  return {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Tester',
    timezone: 'UTC',
    splidConnected: false,
    history: [],
    userContent: 'привет',
    ...over,
  };
}

function lastCall() {
  return createMock.mock.calls[createMock.mock.calls.length - 1]![0] as {
    system: { text: string }[];
    tools: { name?: string }[];
    messages: { role: string; content: { type: string; text?: string }[] }[];
  };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  vi.resetModules();
  createMock.mockClear();
  setRuleMock.mockClear();
  responses = [];
});

describe('system prompt per mode', () => {
  it('uses the calm assistant prompt in assistant mode', async () => {
    responses = [textResponse('Ок.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const { ASSISTANT_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    await runAssistant(ctxFor({ mode: 'assistant' }), handlers);

    const sent = lastCall();
    expect(sent.system[0]!.text).toBe(ASSISTANT_SYSTEM_PROMPT);
    // Still the snappy, non-thinking configuration — only the persona changed.
    expect(sent).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it('leaves the other modes on their own prompts', async () => {
    const { runAssistant } = await import('../src/llm/assistant.js');
    const { SYSTEM_PROMPT, DOTA_SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } = await import(
      '../src/llm/prompts.js'
    );
    for (const [mode, prompt] of [
      ['secretary', SYSTEM_PROMPT],
      ['dota', DOTA_SYSTEM_PROMPT],
      ['tutor', TUTOR_SYSTEM_PROMPT],
    ] as const) {
      responses = [textResponse('Ок.')];
      await runAssistant(ctxFor({ mode }), handlers);
      expect(lastCall().system[0]!.text).toBe(prompt);
    }
  });

  it('keeps the assistant on the FULL toolset (it is a secretary without the persona)', async () => {
    responses = [textResponse('Ок.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor({ mode: 'assistant', splidConnected: true }), handlers);

    const names = lastCall().tools.map((t) => t.name);
    for (const tool of [
      'record_expense',
      'remember',
      'schedule_task',
      'add_poi',
      'surf_forecast',
      'spending_report',
      'set_rule',
    ]) {
      expect(names).toContain(tool);
    }
  });
});

describe('chat rules reaching the model', () => {
  it('puts the chat rules into the context block of the turn', async () => {
    responses = [textResponse('Ок.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(
      ctxFor({
        mode: 'assistant',
        rules: ['Все голосовые расшифровывай и чисти от слов-паразитов'],
      }),
      handlers,
    );

    const block = lastCall().messages[0]!.content[0]!.text ?? '';
    expect(block).toContain('Chat rules');
    expect(block).toContain('1. Все голосовые расшифровывай и чисти от слов-паразитов');
  });

  it('routes a set_rule tool call to the handler and feeds the confirmation back', async () => {
    responses = [
      toolResponse('set_rule', { action: 'add', text: 'Отвечай короче' }),
      textResponse('Записал.'),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(
      ctxFor({ mode: 'assistant', userContent: 'с этого момента отвечай короче' }),
      handlers,
    );

    expect(setRuleMock).toHaveBeenCalledWith({ action: 'add', text: 'Отвечай короче' });
    expect(result).toMatchObject({ kind: 'text', text: 'Записал.', humorizable: false });
  });

  it('reports a malformed set_rule input as a tool error instead of throwing', async () => {
    responses = [
      toolResponse('set_rule', { action: 'burn_it_all' }),
      textResponse('Не понял правило.'),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor({ mode: 'assistant' }), handlers);

    expect(setRuleMock).not.toHaveBeenCalled();
    const followUp = createMock.mock.calls[1]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const results = followUp.messages.at(-1)!.content as { is_error?: boolean }[];
    expect(results[0]!.is_error).toBe(true);
  });
});
