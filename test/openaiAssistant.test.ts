import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toResponsesTools,
  toResponsesInput,
  fromResponsesOutput,
} from '../src/llm/openaiAssistant.js';

// ASSISTANT_PROVIDER=openai runs the SAME assistant loop through a translator.
// These pin the translation both ways, and that the loop actually routes to
// OpenAI (and only there) when the switch is on.

describe('toResponsesTools', () => {
  it('maps custom tools to non-strict functions and web_search to the built-in', () => {
    const out = toResponsesTools([
      {
        name: 'remember',
        description: 'pin a fact',
        input_schema: { type: 'object', properties: { fact: { type: 'string' } } },
      },
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    ] as never);
    expect(out).toEqual([
      {
        type: 'function',
        name: 'remember',
        description: 'pin a fact',
        parameters: { type: 'object', properties: { fact: { type: 'string' } } },
        strict: false,
      },
      { type: 'web_search' },
    ]);
  });
});

describe('toResponsesInput', () => {
  it('renders text, images, PDFs, tool calls and tool results', () => {
    const items = toResponsesInput([
      { role: 'user', content: 'Вася: привет' },
      { role: 'assistant', content: 'Йо' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ctx' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          {
            type: 'document',
            title: 'чек.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'сейчас' },
          { type: 'tool_use', id: 'c1', name: 'remember', input: { fact: 'кофе' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'Запомнил.' },
        ],
      },
    ] as never);
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Вася: привет' }] },
      { role: 'assistant', content: 'Йо' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'ctx' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          { type: 'input_file', filename: 'чек.pdf', file_data: 'data:application/pdf;base64,BBB' },
        ],
      },
      { role: 'assistant', content: 'сейчас' },
      { type: 'function_call', call_id: 'c1', name: 'remember', arguments: '{"fact":"кофе"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'Запомнил.' },
    ]);
  });

  it('marks errors and moves images out of a tool result into a user message', () => {
    const items = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'bad', content: 'Could not parse.', is_error: true },
          {
            type: 'tool_result',
            tool_use_id: 'm1',
            content: [
              { type: 'text', text: 'медиа #5' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'CCC' } },
            ],
          },
        ],
      },
    ] as never);
    expect(items[0]).toEqual({ type: 'function_call_output', call_id: 'bad', output: 'ERROR: Could not parse.' });
    expect(items[1]).toEqual({ type: 'function_call_output', call_id: 'm1', output: 'медиа #5' });
    expect(items[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'input_text' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,CCC' }],
    });
  });
});

describe('fromResponsesOutput', () => {
  it('turns function calls into tool_use blocks with stop_reason tool_use', () => {
    const turn = fromResponsesOutput({
      output: [
        { type: 'reasoning' },
        { type: 'message', content: [{ type: 'output_text', text: 'щас' }] },
        { type: 'function_call', call_id: 'c9', name: 'remember', arguments: '{"fact":"x"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 8 } },
    });
    expect(turn.stop_reason).toBe('tool_use');
    expect(turn.content).toEqual([
      { type: 'text', text: 'щас', citations: null },
      { type: 'tool_use', id: 'c9', name: 'remember', input: { fact: 'x' } },
    ]);
    expect(turn.usage).toMatchObject({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 8 });
  });

  it('a plain answer ends the turn; a cut one reads as max_tokens; bad JSON args become {}', () => {
    expect(
      fromResponsesOutput({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ок' }] }] })
        .stop_reason,
    ).toBe('end_turn');
    expect(
      fromResponsesOutput({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })
        .stop_reason,
    ).toBe('max_tokens');
    const bad = fromResponsesOutput({
      output: [{ type: 'function_call', call_id: 'c', name: 'remember', arguments: '{oops' }],
    });
    expect(bad.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });
});

// --- the loop really switches vendor -------------------------------------------

const anthropicCreate = vi.fn(async () => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'claude' }],
  usage: { input_tokens: 1, output_tokens: 1 },
}));
vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: anthropicCreate } }),
}));

const handlers = {
  remember: () => 'Запомнил.',
  editMemory: () => 'ok',
  editPingList: () => 'ok',
  scheduleTask: () => 'ok',
  surfForecast: async () => 'forecast',
  addPoi: () => 'added',
  spendingReport: async () => 'report',
} as never;

const ctx = {
  defaultCurrency: 'EUR',
  members: [],
  senderName: 'Tester',
  timezone: 'UTC',
  splidConnected: false,
  history: [],
  userContent: 'запомни: люблю кофе',
} as never;

function responsesReply(output: unknown[]) {
  return new Response(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
  });
}

describe('runAssistant with ASSISTANT_PROVIDER=openai', () => {
  beforeEach(() => {
    vi.resetModules();
    anthropicCreate.mockClear();
    process.env.BOT_TOKEN = 't';
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.ASSISTANT_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    delete process.env.ASSISTANT_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_ASSISTANT_MODEL;
    vi.unstubAllGlobals();
  });

  it('runs the tool loop through the Responses API and never touches Anthropic', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([
          { type: 'function_call', call_id: 'c1', name: 'remember', arguments: '{"content":"любит кофе"}' },
        ]),
      )
      .mockResolvedValueOnce(
        responsesReply([{ type: 'message', content: [{ type: 'output_text', text: 'Запомнил ☕' }] }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENAI_ASSISTANT_MODEL = 'gpt-test';

    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(ctx, handlers);

    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/responses');
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(first.model).toBe('gpt-test');
    expect(first.reasoning).toEqual({ effort: 'medium' });
    expect(typeof first.instructions).toBe('string');
    expect(first.tools.some((t: { name?: string }) => t.name === 'remember')).toBe(true);
    // The second call carries the call + its result back.
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(second.input.slice(-2)).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'remember', arguments: '{"content":"любит кофе"}' },
      expect.objectContaining({ type: 'function_call_output', call_id: 'c1' }),
    ]);
    // A tool ran, so the answer stays out of the humorizer — same as on Claude.
    expect(result).toMatchObject({ kind: 'text', text: 'Запомнил ☕', humorizable: false });
  });

  it('fails loudly without an OpenAI key', async () => {
    delete process.env.OPENAI_API_KEY;
    vi.stubGlobal('fetch', vi.fn());
    const { runAssistant } = await import('../src/llm/assistant.js');
    await expect(runAssistant(ctx, handlers)).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('defaults to Anthropic when the switch is unset', async () => {
    delete process.env.ASSISTANT_PROVIDER;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(ctx, handlers);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: 'claude' });
  });
});
