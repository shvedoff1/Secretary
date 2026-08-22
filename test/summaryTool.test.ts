import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTools, SUMMARIZE_CHAT_TOOL } from '../src/llm/tools.js';
import { SummarizeChatZ } from '../src/llm/schema.js';

// How the chat-recap skill reaches the model: which turns get the tool at all, the
// input shape the model is allowed to send, and that the transcript goes BACK to
// the model (no short-circuit) so the recap is written in the chat's own voice.

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

const summarizeMock = vi.fn(() => 'CHAT TRANSCRIPT …\n[10:00] Гоша: погнали на серф');

const handlers = {
  remember: () => 'ok',
  editMemory: () => 'ok',
  editPingList: () => 'ok',
  setRule: () => 'ok',
  scheduleTask: () => 'ok',
  surfForecast: async () => 'forecast',
  addPoi: () => 'added',
  spendingReport: async () => 'report',
  summarizeChat: summarizeMock,
};

function ctxFor(over: Record<string, unknown> = {}) {
  return {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Tester',
    timezone: 'Europe/Moscow',
    splidConnected: false,
    history: [],
    userContent: 'перескажи, что было в последних 200 сообщениях',
    ...over,
  };
}

function toolResponse(name: string, input: Record<string, unknown>) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function textResponse(text: string) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function callAt(i: number) {
  return createMock.mock.calls[i]![0] as {
    tools: { name?: string }[];
    messages: { role: string; content: unknown }[];
  };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  vi.resetModules();
  createMock.mockClear();
  summarizeMock.mockClear();
  responses = [];
});
afterEach(() => {
  delete process.env.ENABLE_CHAT_LOG;
});

const names = (tools: ReturnType<typeof buildTools>): string[] =>
  tools.filter((t) => 'name' in t).map((t) => (t as { name: string }).name);

describe('summarize_chat tool wiring', () => {
  it('is exposed only when asked for (it follows the chat-log switch)', () => {
    expect(
      names(buildTools({ enableWebSearch: false, enableExpense: false, enableSummary: true })),
    ).toContain(SUMMARIZE_CHAT_TOOL);
    expect(
      names(buildTools({ enableWebSearch: false, enableExpense: false, enableSummary: false })),
    ).not.toContain(SUMMARIZE_CHAT_TOOL);
  });

  it('accepts the nullable shape the model actually sends', () => {
    expect(
      SummarizeChatZ.safeParse({ limit: 200, fromDate: null, toDate: null, timezone: 'UTC' })
        .success,
    ).toBe(true);
    expect(
      SummarizeChatZ.safeParse({
        limit: null,
        fromDate: '2026-08-20',
        toDate: '2026-08-21',
        timezone: 'Europe/Moscow',
      }).success,
    ).toBe(true);
    // A malformed date must not reach the day-range maths.
    expect(
      SummarizeChatZ.safeParse({ limit: null, fromDate: 'вчера', toDate: null, timezone: 'UTC' })
        .success,
    ).toBe(false);
  });

  it('offers the tool on an ordinary turn and hands the transcript BACK to the model', async () => {
    responses = [
      toolResponse(SUMMARIZE_CHAT_TOOL, {
        limit: 200,
        fromDate: null,
        toDate: null,
        timezone: 'Europe/Moscow',
      }),
      textResponse('Коротко: договорились ехать на серф.'),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(ctxFor(), handlers);

    expect(names(callAt(0).tools as never)).toContain(SUMMARIZE_CHAT_TOOL);
    expect(summarizeMock).toHaveBeenCalledWith({
      limit: 200,
      fromDate: null,
      toDate: null,
      timezone: 'Europe/Moscow',
    });
    // The transcript came back as a tool_result — the model writes the recap.
    const followUp = JSON.stringify(callAt(1).messages);
    expect(followUp).toContain('tool_result');
    expect(followUp).toContain('погнали на серф');
    expect(result).toMatchObject({
      kind: 'text',
      text: 'Коротко: договорились ехать на серф.',
      // A tool ran, so the tone pass that rewrites plain chat must stay off.
      humorizable: false,
    });
  });

  it('is kept out of tutor chats and of the silent expense-only scan', async () => {
    const { runAssistant } = await import('../src/llm/assistant.js');
    responses = [textResponse('Ок.')];
    await runAssistant(ctxFor({ mode: 'tutor' }), handlers);
    expect(names(callAt(0).tools as never)).not.toContain(SUMMARIZE_CHAT_TOOL);

    responses = [textResponse('Ок.')];
    await runAssistant(ctxFor({ expenseOnly: true, splidConnected: true }), handlers);
    expect(names(callAt(1).tools as never)).not.toContain(SUMMARIZE_CHAT_TOOL);
  });

  it('disappears when chat logging is off — nothing is recorded to recap', async () => {
    process.env.ENABLE_CHAT_LOG = 'false';
    vi.resetModules();
    responses = [textResponse('Ок.')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctxFor(), handlers);
    expect(names(callAt(0).tools as never)).not.toContain(SUMMARIZE_CHAT_TOOL);
  });
});
