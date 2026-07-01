import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ADMIN_TELEGRAM_ID: '123',
};

/** Reset env to a known baseline plus the given overrides (undefined deletes). */
function setEnv(extra: Record<string, string | undefined>): void {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_HUMOR_MODEL;
  delete process.env.ENABLE_HUMOR;
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Build a fake chat-completions response body. */
function completion(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200 },
  );
}

describe('humorize', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isHumorEnabled needs both the flag and a key', async () => {
    setEnv({ ENABLE_HUMOR: 'true', OPENAI_API_KEY: undefined });
    let mod = await import('../src/llm/humorize.js');
    expect(mod.isHumorEnabled()).toBe(false);

    vi.resetModules();
    setEnv({ ENABLE_HUMOR: 'false', OPENAI_API_KEY: 'sk-test' });
    mod = await import('../src/llm/humorize.js');
    expect(mod.isHumorEnabled()).toBe(false);

    vi.resetModules();
    setEnv({ ENABLE_HUMOR: 'true', OPENAI_API_KEY: 'sk-test' });
    mod = await import('../src/llm/humorize.js');
    expect(mod.isHumorEnabled()).toBe(true);
  });

  it('posts the text to chat/completions and returns the trimmed rewrite', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_HUMOR_MODEL: 'gpt-5-mini' });
    const fetchMock = vi.fn(async () => completion('  ха, держи кофе ☕  '));
    vi.stubGlobal('fetch', fetchMock);

    const { humorize } = await import('../src/llm/humorize.js');
    const out = await humorize('Вот твой кофе.');

    expect(out).toBe('ха, держи кофе ☕');
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-5-mini');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Вот твой кофе.' });
    // Minimal payload — no custom temperature (newer mini models reject it).
    expect(body.temperature).toBeUndefined();
  });

  it('injects the chat lexicon into the system prompt when provided', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    const fetchMock = vi.fn(async () => completion('yo'));
    vi.stubGlobal('fetch', fetchMock);

    const { humorize } = await import('../src/llm/humorize.js');
    await humorize('hi', [{ term: 'тип', gloss: 'типа' }, { term: 'братик' }]);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const system = body.messages[0].content as string;
    expect(system).toContain('Chat lexicon');
    expect(system).toContain('«тип» — типа');
    expect(system).toContain('«братик»');
    // A glossless term shows no dangling dash.
    expect(system).not.toContain('«братик» —');
  });

  it('logs exactly which slang was sent to openai (and stays quiet with none)', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => completion('yo')));
    const { logger } = await import('../src/logger.js');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const { humorize } = await import('../src/llm/humorize.js');

    await humorize('hi', [{ term: 'пихалыч', gloss: 'рот' }, { term: 'иншала' }]);
    expect(info).toHaveBeenCalledWith(
      { count: 2, slang: ['пихалыч — рот', 'иншала'] },
      'humorizer slang → openai',
    );

    // No lexicon → no slang log line at all.
    info.mockClear();
    await humorize('hi');
    expect(info).not.toHaveBeenCalledWith(expect.anything(), 'humorizer slang → openai');
  });

  it('leaves the system prompt untouched when no lexicon is given', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    const fetchMock = vi.fn(async () => completion('yo'));
    vi.stubGlobal('fetch', fetchMock);

    const { humorize } = await import('../src/llm/humorize.js');
    await humorize('hi');
    await humorize('hi', []);

    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.messages[0].content).not.toContain('Chat lexicon');
    }
  });

  it('honors a custom OPENAI_BASE_URL', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://proxy.example.com/v1' });
    const fetchMock = vi.fn(async () => completion('lol'));
    vi.stubGlobal('fetch', fetchMock);

    const { humorize } = await import('../src/llm/humorize.js');
    await humorize('hi');

    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example.com/v1/chat/completions');
  });

  it('throws when not configured', async () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const { humorize } = await import('../src/llm/humorize.js');
    await expect(humorize('x')).rejects.toThrow(/not configured/);
  });

  it('throws on a non-ok response', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { humorize } = await import('../src/llm/humorize.js');
    await expect(humorize('x')).rejects.toThrow(/humorize failed: 500/);
  });

  it('throws on empty content', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => completion('   ')));
    const { humorize } = await import('../src/llm/humorize.js');
    await expect(humorize('x')).rejects.toThrow(/empty/);
  });

  describe('humorizeOrOriginal', () => {
    it('returns the original untouched when disabled', async () => {
      setEnv({ ENABLE_HUMOR: 'false', OPENAI_API_KEY: 'sk-test' });
      const fetchMock = vi.fn(async () => completion('funny'));
      vi.stubGlobal('fetch', fetchMock);

      const { humorizeOrOriginal } = await import('../src/llm/humorize.js');
      expect(await humorizeOrOriginal('plain')).toBe('plain');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the rewrite when enabled', async () => {
      setEnv({ ENABLE_HUMOR: 'true', OPENAI_API_KEY: 'sk-test' });
      vi.stubGlobal('fetch', vi.fn(async () => completion('funny')));
      const { humorizeOrOriginal } = await import('../src/llm/humorize.js');
      expect(await humorizeOrOriginal('plain')).toBe('funny');
    });

    it('falls back to the original when the API fails', async () => {
      setEnv({ ENABLE_HUMOR: 'true', OPENAI_API_KEY: 'sk-test' });
      vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
      const { humorizeOrOriginal } = await import('../src/llm/humorize.js');
      expect(await humorizeOrOriginal('plain')).toBe('plain');
    });
  });

  describe('humorizeWithPreview', () => {
    it('sends the pre-OpenAI original, then returns the rewrite', async () => {
      setEnv({ ENABLE_HUMOR: 'true', OPENAI_API_KEY: 'sk-test' });
      vi.stubGlobal('fetch', vi.fn(async () => completion('after')));
      const { humorizeWithPreview } = await import('../src/llm/humorize.js');

      const sent: string[] = [];
      const out = await humorizeWithPreview('before', async (o) => {
        sent.push(o);
      });

      expect(sent).toEqual(['before']); // original captured before the rewrite
      expect(out).toBe('after');
    });

    it('does not send a preview (or call the API) when disabled', async () => {
      setEnv({ ENABLE_HUMOR: 'false', OPENAI_API_KEY: 'sk-test' });
      const fetchMock = vi.fn(async () => completion('after'));
      vi.stubGlobal('fetch', fetchMock);
      const { humorizeWithPreview } = await import('../src/llm/humorize.js');

      const sent: string[] = [];
      const out = await humorizeWithPreview('before', async (o) => {
        sent.push(o);
      });

      expect(sent).toEqual([]);
      expect(out).toBe('before');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still returns the rewrite when the preview send fails', async () => {
      setEnv({ ENABLE_HUMOR: 'true', OPENAI_API_KEY: 'sk-test' });
      vi.stubGlobal('fetch', vi.fn(async () => completion('after')));
      const { humorizeWithPreview } = await import('../src/llm/humorize.js');

      const out = await humorizeWithPreview('before', async () => {
        throw new Error('admin DM blocked');
      });

      expect(out).toBe('after');
    });
  });
});

describe('buildHumorSystemPrompt', () => {
  it('returns the base prompt unchanged for an empty/absent lexicon', async () => {
    setEnv({});
    const { buildHumorSystemPrompt } = await import('../src/llm/humorize.js');
    const base = buildHumorSystemPrompt();
    expect(base).not.toContain('Chat lexicon');
    expect(buildHumorSystemPrompt([])).toBe(base);
    // A term that is only whitespace is dropped, leaving the base prompt.
    expect(buildHumorSystemPrompt([{ term: '   ' }])).toBe(base);
  });

  it('appends the slang list, respecting glosses', async () => {
    setEnv({});
    const { buildHumorSystemPrompt } = await import('../src/llm/humorize.js');
    const out = buildHumorSystemPrompt([
      { term: 'тип', gloss: 'типа' },
      { term: 'братик' },
      { term: 'изи', gloss: '  ' },
    ]);
    expect(out).toContain('Chat lexicon');
    expect(out).toContain('«тип» — типа');
    expect(out).toContain('«братик»');
    // A blank gloss is treated as no gloss (no dangling dash).
    expect(out).toContain('«изи»');
    expect(out).not.toContain('«изи» —');
  });
});

describe('classifyHumorDecision', () => {
  it('reports the FIRST gate that fires, in runtime order', async () => {
    const { classifyHumorDecision } = await import('../src/llm/humorize.js');

    // Humour off wins even if everything else would have allowed it.
    expect(
      classifyHumorDecision({ enabled: false, humorizable: true, money: false }),
    ).toBe('humor-disabled');

    // A tool answer is never humorized (facts must stay verbatim).
    expect(
      classifyHumorDecision({ enabled: true, humorizable: false, money: false }),
    ).toBe('tool-answer');

    // Money context blocks a plain-chat answer.
    expect(
      classifyHumorDecision({ enabled: true, humorizable: true, money: true }),
    ).toBe('money-context');

    // Plain chatter, humour on → goes to OpenAI.
    expect(
      classifyHumorDecision({ enabled: true, humorizable: true, money: false }),
    ).toBe('sent');
  });
});
