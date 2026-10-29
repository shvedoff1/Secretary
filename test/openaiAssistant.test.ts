import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toResponsesTools,
  toResponsesInput,
  fromResponsesOutput,
} from '../src/llm/openaiAssistant.js';

// LLM_PROVIDER=openai runs every model call through a translator under
// getAnthropic(). These pin the translation both ways, the tier → model map, and
// that the dialogue loop and a hidden pass actually route to OpenAI.

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

// --- the switch, end to end ----------------------------------------------------

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
  return new Response(
    JSON.stringify({ status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } }),
    { status: 200 },
  );
}

const textReply = (text: string) =>
  responsesReply([{ type: 'message', content: [{ type: 'output_text', text }] }]);

const TOUCHED = [
  'LLM_PROVIDER',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_ASSISTANT_MODEL',
  'ANTHROPIC_CALENDAR_MODEL',
];

describe('LLM_PROVIDER=openai', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BOT_TOKEN = 't';
    process.env.ADMIN_TELEGRAM_ID = '1';
    delete process.env.ANTHROPIC_API_KEY; // not needed on openai
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    for (const k of TOUCHED) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = 'x';
    vi.unstubAllGlobals();
  });

  it('runs the dialogue tool loop on SOL through the Responses API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responsesReply([
          { type: 'function_call', call_id: 'c1', name: 'remember', arguments: '{"content":"любит кофе"}' },
        ]),
      )
      .mockResolvedValueOnce(textReply('Запомнил ☕'));
    vi.stubGlobal('fetch', fetchMock);

    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(ctx, handlers);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/responses');
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(first.model).toBe('gpt-6-sol');
    expect(first.reasoning).toEqual({ effort: 'medium' });
    expect(typeof first.instructions).toBe('string');
    expect(first.instructions.length).toBeGreaterThan(100);
    expect(first.tools.some((t: { name?: string }) => t.name === 'remember')).toBe(true);
    // Anthropic-only knobs never leak into the OpenAI body.
    expect(first).not.toHaveProperty('thinking');
    expect(first).not.toHaveProperty('system');
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(second.input.slice(-2)).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'remember', arguments: '{"content":"любит кофе"}' },
      expect.objectContaining({ type: 'function_call_output', call_id: 'c1' }),
    ]);
    // A tool ran, so the answer stays out of the humorizer — same as on Claude.
    expect(result).toMatchObject({ kind: 'text', text: 'Запомнил ☕', humorizable: false });
  });

  it('honours an OPENAI_ASSISTANT_MODEL override', async () => {
    process.env.OPENAI_ASSISTANT_MODEL = 'gpt-test';
    const fetchMock = vi.fn().mockResolvedValue(textReply('йо'));
    vi.stubGlobal('fetch', fetchMock);
    const { runAssistant } = await import('../src/llm/assistant.js');
    await runAssistant(ctx, handlers);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe('gpt-test');
  });

  it('runs a hidden pass on LUNA at low effort', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textReply('заметки'));
    vi.stubGlobal('fetch', fetchMock);
    const { condenseChunk } = await import('../src/llm/summarize.js');
    expect(await condenseChunk('Вася: привет\nПетя: йо')).toBe('заметки');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.reasoning).toEqual({ effort: 'low' });
    // No Anthropic temperature/thinking pass-through on the cheap tier either.
    expect(body).not.toHaveProperty('temperature');
  });

  it('maps tiers off the configured Anthropic ids: dialogue → SOL, precise/calendar → ASTRA, rest → LUNA', async () => {
    process.env.ANTHROPIC_CALENDAR_MODEL = 'claude-calendar-x';
    const { loadConfig } = await import('../src/config.js');
    const { openaiTierFor } = await import('../src/llm/client.js');
    const cfg = loadConfig();
    expect(openaiTierFor(cfg.ANTHROPIC_MODEL, cfg)).toEqual({ model: 'gpt-6-sol', effort: 'medium' });
    expect(openaiTierFor(cfg.ANTHROPIC_PRECISE_MODEL, cfg)).toEqual({ model: 'gpt-6-astra', effort: 'medium' });
    expect(openaiTierFor('claude-calendar-x', cfg).model).toBe('gpt-6-astra');
    expect(openaiTierFor(cfg.ANTHROPIC_SUMMARY_MODEL, cfg)).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(openaiTierFor(cfg.ANTHROPIC_CLASSIFY_MODEL, cfg).model).toBe('gpt-6-luna');
  });

  it('passes a caller timeout / no-retry through (the expense classifier)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { getAnthropic } = await import('../src/llm/client.js');
    await expect(
      getAnthropic().messages.create(
        { model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
        { timeout: 500, maxRetries: 0 },
      ),
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('boots without ANTHROPIC_API_KEY but refuses without OPENAI_API_KEY', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().LLM_PROVIDER).toBe('openai');
    vi.resetModules();
    delete process.env.OPENAI_API_KEY;
    const fresh = await import('../src/config.js');
    expect(() => fresh.loadConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it('defaults to Anthropic, which still requires its key', async () => {
    delete process.env.LLM_PROVIDER;
    let { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY/);
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = 'a';
    ({ loadConfig } = await import('../src/config.js'));
    expect(loadConfig().LLM_PROVIDER).toBe('anthropic');
    const { getAnthropic } = await import('../src/llm/client.js');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    expect(getAnthropic()).toBeInstanceOf(Anthropic);
  });
});
