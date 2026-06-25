import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ADMIN_TELEGRAM_ID: '123',
};

function setEnv(extra: Record<string, string | undefined>): void {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_HUMOR_MODEL;
  delete process.env.ENABLE_EXPENSE_QUIP;
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200 },
  );
}

describe('expenseQuip', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isExpenseQuipEnabled needs a key and is ON by default', async () => {
    setEnv({ OPENAI_API_KEY: undefined });
    let mod = await import('../src/llm/expenseQuip.js');
    expect(mod.isExpenseQuipEnabled()).toBe(false); // no key

    vi.resetModules();
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    mod = await import('../src/llm/expenseQuip.js');
    expect(mod.isExpenseQuipEnabled()).toBe(true); // default true + key

    vi.resetModules();
    setEnv({ OPENAI_API_KEY: 'sk-test', ENABLE_EXPENSE_QUIP: 'false' });
    mod = await import('../src/llm/expenseQuip.js');
    expect(mod.isExpenseQuipEnabled()).toBe(false); // explicitly off
  });

  it('returns null without calling the API when disabled', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', ENABLE_EXPENSE_QUIP: 'false' });
    const fetchMock = vi.fn(async () => completion('joke'));
    vi.stubGlobal('fetch', fetchMock);
    const { expenseQuip } = await import('../src/llm/expenseQuip.js');
    expect(await expenseQuip('Такси')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for an empty summary (no API call)', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    const fetchMock = vi.fn(async () => completion('joke'));
    vi.stubGlobal('fetch', fetchMock);
    const { expenseQuip } = await import('../src/llm/expenseQuip.js');
    expect(await expenseQuip('   ')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the summary and returns the trimmed joke', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_HUMOR_MODEL: 'gpt-5-mini' });
    const fetchMock = vi.fn(async () => completion('  ну ты и шопоголик бро 🤙  '));
    vi.stubGlobal('fetch', fetchMock);

    const { expenseQuip } = await import('../src/llm/expenseQuip.js');
    const out = await expenseQuip('Такси, Ужин');

    expect(out).toBe('ну ты и шопоголик бро 🤙');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-5-mini');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toContain('Такси, Ужин');
  });

  it('returns null (never throws) on a non-ok response', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const { expenseQuip } = await import('../src/llm/expenseQuip.js');
    expect(await expenseQuip('Кофе')).toBeNull();
  });

  it('returns null when the model returns empty content', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => completion('   ')));
    const { expenseQuip } = await import('../src/llm/expenseQuip.js');
    expect(await expenseQuip('Кофе')).toBeNull();
  });
});
