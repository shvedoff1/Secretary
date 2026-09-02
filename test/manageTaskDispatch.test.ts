import { describe, it, expect, vi, beforeEach } from 'vitest';

// runAssistant routes a `manage_task` tool call to the handler and marks the
// turn `scheduled` (kept out of history, like schedule_task — a lingering
// «перенеси на час» must not re-fire on the next turn).
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

describe('runAssistant manage_task dispatch', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
    responses = [];
    createMock.mockClear();
    vi.resetModules();
  });

  it('calls the manageTask handler and marks the turn scheduled', async () => {
    const manageTask = vi.fn(() => 'Перенёс #15 «Сушилка»: следующий запуск через 1 ч 50 мин');
    responses = [
      toolResponse('manage_task', {
        action: 'reschedule',
        id: 15,
        cron: null,
        inMinutes: 110,
        timezone: null,
      }),
      textResponse('Готово — перенёс #15 на 19:29.'),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(
      {
        defaultCurrency: 'EUR',
        members: [],
        memory: '',
        senderName: 'Tester',
        timezone: 'Asia/Ho_Chi_Minh',
        splidConnected: false,
        history: [],
        userContent: 'на 1.50 от сейчас',
      } as never,
      { scheduleTask: () => 'ok', manageTask } as never,
    );
    expect(manageTask).toHaveBeenCalledWith({
      action: 'reschedule',
      id: 15,
      cron: null,
      inMinutes: 110,
      timezone: null,
    });
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.scheduled).toBe(true);
      expect(result.humorizable).toBe(false);
    }
    // The handler's confirmation reached the model as the tool result.
    const second = createMock.mock.calls[1]![0] as { messages: { content: unknown }[] };
    expect(JSON.stringify(second.messages.at(-1)!.content)).toContain('Перенёс #15');
  });

  it('returns a tool error for a malformed manage_task call without touching the handler', async () => {
    const manageTask = vi.fn(() => 'never');
    responses = [
      toolResponse('manage_task', { action: 'edit', id: 'x' }),
      textResponse('Не понял, какое напоминание.'),
    ];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(
      {
        defaultCurrency: 'EUR',
        members: [],
        memory: '',
        senderName: 'Tester',
        timezone: null,
        splidConnected: false,
        history: [],
        userContent: 'перенеси',
      } as never,
      { scheduleTask: () => 'ok', manageTask } as never,
    );
    expect(manageTask).not.toHaveBeenCalled();
    const second = createMock.mock.calls[1]![0] as { messages: { content: unknown }[] };
    expect(JSON.stringify(second.messages.at(-1)!.content)).toContain('"is_error":true');
  });
});
