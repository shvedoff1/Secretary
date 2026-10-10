import { describe, it, expect, vi, beforeEach } from 'vitest';

// The assistant side of the split: which tools are offered and what the
// context block tells the model, in a DM vs a group.

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

const ctx = (over: Record<string, unknown>) => ({
  defaultCurrency: 'EUR',
  members: [],
  senderName: 'Tester',
  timezone: 'UTC',
  splidConnected: false,
  history: [],
  userContent: 'привет',
  ...over,
});

const call = () =>
  createMock.mock.calls.at(-1)![0] as {
    tools: { name?: string }[];
    messages: { content: { type: string; text?: string }[] }[];
  };
const tools = () => call().tools.map((t) => t.name);
const contextText = () => call().messages.at(-1)!.content[0]!.text ?? '';

beforeEach(() => {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  delete process.env.ENABLE_FOOD;
  vi.resetModules();
  createMock.mockClear();
  responses = [];
});

describe('feature split in the assistant', () => {
  it('a DM gets the diary and no expense tools, and is told expenses live in the group', async () => {
    responses = [text('ok')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(
      ctx({ privateChat: true, foodAvailable: true, splidConnected: false }),
      {} as never,
    );
    expect(tools()).toEqual(expect.arrayContaining(['log_food', 'food_report']));
    expect(tools()).not.toContain('record_expense');
    expect(tools()).not.toContain('spending_report');
    expect(contextText()).toContain('Splid: group chats only');
    expect(contextText()).not.toContain('Calorie diary: private chat only');
  });

  it('a group gets expenses and no diary tools, and is told the diary lives in the DM', async () => {
    responses = [text('ok')];
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(
      ctx({ privateChat: false, foodAvailable: false, splidConnected: true }),
      {} as never,
    );
    expect(tools()).toContain('record_expense');
    expect(tools()).not.toContain('log_food');
    expect(tools()).not.toContain('food_report');
    expect(contextText()).toContain('Splid: connected');
    expect(contextText()).toContain('Calorie diary: private chat only');
  });

  it('the prompt tells the model how to redirect on both sides', async () => {
    const { SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(SYSTEM_PROMPT).toContain('If "Splid" says "group chats only"');
    expect(SYSTEM_PROMPT).toContain('the diary lives in the PRIVATE chat with you only');
  });
});
