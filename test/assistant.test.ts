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
