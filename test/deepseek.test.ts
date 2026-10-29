import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// LLM_PROVIDER=deepseek runs every model call on DeepSeek's Anthropic-compatible
// endpoint: the request is cleaned (model ids, thinking, cache_control, server
// web_search → DeepSeek Search/Fetch), photos/PDFs and outages go to the
// fallback vendor. These pin each piece, then the switch end to end.

const TOUCHED = [
  'LLM_PROVIDER',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_VISION_MODEL',
  'DEEPSEEK_FALLBACK',
  'DEEPSEEK_THINKING',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_CALENDAR_MODEL',
];

function baseEnv(extra: Record<string, string | undefined> = {}): void {
  for (const k of TOUCHED) delete process.env[k];
  process.env.BOT_TOKEN = 't';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.LLM_PROVIDER = 'deepseek';
  process.env.DEEPSEEK_API_KEY = 'ds-test';
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function load() {
  const { loadConfig } = await import('../src/config.js');
  const ds = await import('../src/llm/deepseek.js');
  return { cfg: loadConfig(), ...ds };
}

/** An Anthropic-shaped reply, as DeepSeek's endpoint sends it. */
function msg(content: unknown[], stop: string = 'end_turn'): Anthropic.Message {
  return {
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-v4-pro',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

beforeEach(() => {
  vi.resetModules();
  baseEnv();
});
afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = 'x';
  vi.unstubAllGlobals();
});

describe('toDeepseekParams', () => {
  it('maps tiers to DeepSeek models and thinking, drops Anthropic-only knobs', async () => {
    process.env.ANTHROPIC_CALENDAR_MODEL = 'claude-calendar-x';
    const { cfg, toDeepseekParams } = await load();
    const req = {
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: 16_000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      tools: [
        { name: 'remember', input_schema: { type: 'object', properties: {} } },
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
      ],
    } as never;
    const body = toDeepseekParams(req, cfg, 'deepseek-v4-pro') as unknown as Record<string, unknown>;
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.system).toBe('SYS');
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body).not.toHaveProperty('output_config');
    expect(JSON.stringify(body)).not.toContain('cache_control');
    // Claude's server search becomes DeepSeek Search + Fetch function tools.
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(['remember', 'web_search', 'web_fetch']);
    expect((body.tools as object[]).every((t) => 'input_schema' in t)).toBe(true);

    const cheap = toDeepseekParams(
      { model: cfg.ANTHROPIC_SUMMARY_MODEL, max_tokens: 2048, thinking: { type: 'disabled' }, temperature: 0, messages: [] } as never,
      cfg,
      'deepseek-flash',
    ) as unknown as Record<string, unknown>;
    expect(cheap.thinking).toEqual({ type: 'disabled' });
    expect(cheap.temperature).toBe(0);
  });

  it('turns text documents into text and drops search when DEEPSEEK_SEARCH is off', async () => {
    process.env.DEEPSEEK_SEARCH = 'false';
    const { cfg, toDeepseekParams } = await load();
    const body = toDeepseekParams(
      {
        model: cfg.ANTHROPIC_MODEL,
        max_tokens: 16_000,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        messages: [
          { role: 'user', content: [{ type: 'document', title: 'a.txt', source: { type: 'text', media_type: 'text/plain', data: 'строка' } }] },
        ],
      } as never,
      cfg,
      'deepseek-v4-pro',
    );
    delete process.env.DEEPSEEK_SEARCH;
    expect(body.tools).toBeUndefined();
    expect(body.messages[0]!.content).toEqual([{ type: 'text', text: 'a.txt\nстрока' }]);
  });
});

describe('expandEmulated', () => {
  const searchUse = { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } };
  const searchRes = {
    type: 'web_search_tool_result',
    tool_use_id: 's1',
    content: { type: 'deepseek_tool_output', text: 'результаты', is_error: false },
  };

  it('splits a mid-message search back into tool_use / tool_result', async () => {
    const { expandEmulated } = await load();
    const out = expandEmulated([
      { role: 'user', content: 'вопрос' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 't1', signature: '' }, searchUse, searchRes, { type: 'text', text: 'ответ' }],
      },
    ] as never);
    expect(out).toEqual([
      { role: 'user', content: 'вопрос' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't1', signature: '' }, { type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'результаты' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] },
    ]);
  });

  it('merges trailing results into the caller’s tool_result turn (search + real tool in one reply)', async () => {
    const { expandEmulated } = await load();
    const out = expandEmulated([
      { role: 'assistant', content: [searchUse, { type: 'tool_use', id: 'r1', name: 'remember', input: {} }, searchRes] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }] },
    ] as never);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
          { type: 'tool_use', id: 'r1', name: 'remember', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 's1', content: 'результаты' },
          { type: 'tool_result', tool_use_id: 'r1', content: 'ok' },
        ],
      },
    ]);
  });

  it('closes a pause_turn tail with its own user turn', async () => {
    const { expandEmulated } = await load();
    const out = expandEmulated([{ role: 'assistant', content: [searchUse, searchRes] }] as never);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'результаты' }] });
  });

  it('forFallback flattens searches to text and drops DeepSeek thinking', async () => {
    const { forFallback } = await load();
    const out = forFallback([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: '' }, searchUse, searchRes, { type: 'text', text: 'итог' }] },
    ] as never);
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '[результат поиска]\nрезультаты' },
      { type: 'text', text: 'итог' },
    ]);
  });
});

describe('media', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } };
  const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } };

  it('finds images and PDFs, including inside a tool result', async () => {
    const { scanMedia } = await load();
    expect(scanMedia([{ role: 'user', content: 'текст' }])).toEqual({ image: false, pdf: false });
    expect(scanMedia([{ role: 'user', content: [image] }] as never)).toEqual({ image: true, pdf: false });
    expect(
      scanMedia([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'v', content: [pdf] }] }] as never),
    ).toEqual({ image: false, pdf: true });
  });

  it('stripMedia leaves a note the model must pass on', async () => {
    const { stripMedia } = await load();
    const out = stripMedia([{ role: 'user', content: [image, pdf] }] as never, { images: true });
    const texts = (out[0]!.content as { text: string }[]).map((b) => b.text);
    expect(texts[0]).toMatch(/не видит картинки/);
    expect(texts[1]).toMatch(/не читает PDF/);
  });
});

describe('createWithSearch', () => {
  it('runs DeepSeek Search itself and hands back server-tool blocks + the answer', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 'Погода', url: 'https://w.example', snippet: '+30' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createWithSearch } = await load();
    const create = vi
      .fn()
      .mockResolvedValueOnce(msg([{ type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'погода Нячанг' } }], 'tool_use'))
      .mockResolvedValueOnce(msg([{ type: 'text', text: '+30, жара' }]));

    const res = await createWithSearch(create, { model: 'deepseek-v4-pro', max_tokens: 100, messages: [{ role: 'user', content: 'погода?' }] });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ds-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ query: 'погода Нячанг' });
    // Second DeepSeek call carries the search exchange.
    const second = create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming;
    const last = second.messages.at(-1)!.content as { type: string; content: string }[];
    expect(last[0]!.type).toBe('tool_result');
    expect(last[0]!.content).toContain('https://w.example');
    // The caller sees no tool_use (nothing for it to run) — just the answer.
    expect(res.stop_reason).toBe('end_turn');
    expect(res.content.map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
    expect(res.usage.input_tokens).toBe(20);
  });

  it('returns tool_use when the model also asked for a real tool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const { createWithSearch } = await load();
    const create = vi.fn().mockResolvedValueOnce(
      msg(
        [
          { type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
          { type: 'tool_use', id: 'r1', name: 'remember', input: { content: 'y' } },
        ],
        'tool_use',
      ),
    );
    const res = await createWithSearch(create, { model: 'm', max_tokens: 100, messages: [] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlock).name)).toEqual(['remember']);
  });

  it('a failed search is an is_error result, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { runDsSearchTool } = await import('../src/llm/deepseekSearch.js');
    const out = await runDsSearchTool('web_search', { query: 'x' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/HTTP 500/);
  });

  it('web_fetch posts the url and caps the page', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ title: 'T', content: 'x'.repeat(20_000) }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { runDsSearchTool, FETCH_MAX_CHARS } = await import('../src/llm/deepseekSearch.js');
    const out = await runDsSearchTool('web_fetch', { url: 'https://a.example/p' });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(out.text.startsWith('T\nhttps://a.example/p')).toBe(true);
    expect(out.text).toMatch(new RegExp(`показано ${FETCH_MAX_CHARS} из 20000`));
  });
});

describe('deepseekCreate routing', () => {
  const photoTurn = {
    model: 'claude-sonnet-5-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A' } }] }],
  } as never;

  it('sends a photo turn to the fallback with the caller’s own model id', async () => {
    const { deepseekCreate } = await load();
    const deepseek = vi.fn();
    const fallback = vi.fn().mockResolvedValue(msg([{ type: 'text', text: 'вижу чек' }]));
    const res = await deepseekCreate({ deepseek, fallback })(photoTurn);
    expect(deepseek).not.toHaveBeenCalled();
    expect((fallback.mock.calls[0]![0] as { model: string }).model).toBe('claude-sonnet-5-5');
    expect((res.content[0] as Anthropic.TextBlock).text).toBe('вижу чек');
  });

  it('uses DEEPSEEK_VISION_MODEL for a photo when set', async () => {
    process.env.DEEPSEEK_VISION_MODEL = 'ds-vision';
    const { deepseekCreate } = await load();
    const deepseek = vi.fn().mockResolvedValue(msg([{ type: 'text', text: 'ок' }]));
    await deepseekCreate({ deepseek, fallback: vi.fn() })(photoTurn);
    expect((deepseek.mock.calls[0]![0] as { model: string }).model).toBe('ds-vision');
  });

  it('without a fallback, swaps the photo for a note and stays on DeepSeek', async () => {
    const { deepseekCreate } = await load();
    const deepseek = vi.fn().mockResolvedValue(msg([{ type: 'text', text: 'не вижу' }]));
    await deepseekCreate({ deepseek, fallback: null })(photoTurn);
    const sent = deepseek.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(JSON.stringify(sent.messages)).toMatch(/не видит картинки/);
    expect(sent.model).toBe('deepseek-v4-pro');
  });

  it('falls back when DeepSeek is down — except for a no-retry (latency-bound) call', async () => {
    const { deepseekCreate } = await load();
    const deepseek = vi.fn().mockRejectedValue(new Error('503'));
    const fallback = vi.fn().mockResolvedValue(msg([{ type: 'text', text: 'claude' }]));
    const create = deepseekCreate({ deepseek, fallback });
    const req = { model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } as never;
    expect(((await create(req)).content[0] as Anthropic.TextBlock).text).toBe('claude');
    await expect(create(req, { maxRetries: 0 })).rejects.toThrow('503');
  });

  it('resolveFallback picks Claude, then OpenAI, honouring an explicit choice', async () => {
    const { cfg, resolveFallback } = await load();
    expect(resolveFallback({ ...cfg, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined })).toBeNull();
    expect(resolveFallback({ ...cfg, ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })).toBe('anthropic');
    expect(resolveFallback({ ...cfg, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'o' })).toBe('openai');
    expect(resolveFallback({ ...cfg, DEEPSEEK_FALLBACK: 'openai', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })).toBe('openai');
    expect(resolveFallback({ ...cfg, DEEPSEEK_FALLBACK: 'none', ANTHROPIC_API_KEY: 'a' })).toBeNull();
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

const reply = (content: unknown[], stop = 'end_turn') =>
  new Response(JSON.stringify(msg(content, stop)), { status: 200, headers: { 'content-type': 'application/json' } });

describe('LLM_PROVIDER=deepseek', () => {
  it('runs the dialogue tool loop on DeepSeek PRO through its Anthropic endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply([{ type: 'tool_use', id: 'c1', name: 'remember', input: { content: 'любит кофе' } }], 'tool_use'))
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'Запомнил ☕' }]));
    vi.stubGlobal('fetch', fetchMock);

    const { runAssistant } = await import('../src/llm/assistant.js');
    const result = await runAssistant(ctx, handlers);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe('https://api.deepseek.com/anthropic/v1/messages');
    const first = JSON.parse(init.body as string);
    expect(first.model).toBe('deepseek-v4-pro');
    expect(first.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(JSON.stringify(first)).not.toContain('cache_control');
    expect(first.tools.some((t: { name: string }) => t.name === 'web_fetch')).toBe(true);
    expect(result).toMatchObject({ kind: 'text', text: 'Запомнил ☕', humorizable: false });
  });

  it('boots without ANTHROPIC_API_KEY but refuses without DEEPSEEK_API_KEY', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().LLM_PROVIDER).toBe('deepseek');
    vi.resetModules();
    delete process.env.DEEPSEEK_API_KEY;
    const fresh = await import('../src/config.js');
    expect(() => fresh.loadConfig()).toThrow(/DEEPSEEK_API_KEY/);
  });
});
