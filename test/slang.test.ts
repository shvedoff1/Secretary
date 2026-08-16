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
  delete process.env.OPENAI_REASONING_EFFORT;
  delete process.env.ENABLE_SLANG;
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

describe('slang pass: configuration', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is on by default once a key is present, off without one', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    let mod = await import('../src/llm/slang.js');
    expect(mod.isSlangPassEnabled()).toBe(true);

    vi.resetModules();
    setEnv({ OPENAI_API_KEY: undefined });
    mod = await import('../src/llm/slang.js');
    expect(mod.isSlangPassEnabled()).toBe(false);
  });

  it('honours ENABLE_SLANG=false even with a key', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', ENABLE_SLANG: 'false' });
    const mod = await import('../src/llm/slang.js');
    expect(mod.isSlangPassEnabled()).toBe(false);
  });

  it('does NOT depend on ENABLE_HUMOR — the two switches are independent', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', ENABLE_HUMOR: 'false' });
    const slang = await import('../src/llm/slang.js');
    const humor = await import('../src/llm/humorize.js');
    expect(humor.isHumorEnabled()).toBe(false);
    expect(slang.isSlangPassEnabled()).toBe(true);
  });
});

describe('slang pass: prompt', () => {
  beforeEach(() => {
    vi.resetModules();
    setEnv({ OPENAI_API_KEY: 'sk-test' });
  });

  it('lists the chat lexicon with glosses', async () => {
    const { buildSlangSystemPrompt } = await import('../src/llm/slang.js');
    const prompt = buildSlangSystemPrompt([
      { term: 'катка', gloss: 'игра' },
      { term: 'изи', gloss: '' },
    ]);
    expect(prompt).toContain('«катка» — игра');
    expect(prompt).toContain('«изи»');
    // It's a vocabulary pass, not the humorizer: no joke instructions.
    expect(prompt).toMatch(/Do NOT add jokes/);
    expect(prompt).toMatch(/character-for-character/);
  });

  it('skips blank terms and degrades to the base prompt when empty', async () => {
    const { buildSlangSystemPrompt } = await import('../src/llm/slang.js');
    const base = buildSlangSystemPrompt([]);
    expect(base).not.toContain('Chat lexicon');
    expect(buildSlangSystemPrompt([{ term: '   ', gloss: 'x' }])).toBe(base);
  });
});

describe('classifySlangDecision', () => {
  const opts = {
    enabled: true,
    humorized: false,
    toned: false,
    lexiconSize: 3,
  };

  it('sends an ordinary reply through', async () => {
    const { classifySlangDecision } = await import('../src/llm/slang.js');
    expect(classifySlangDecision(opts)).toBe('sent');
  });

  it('sends a tool/factual answer through — the whole point of the feature', async () => {
    const { classifySlangDecision } = await import('../src/llm/slang.js');
    // A tool answer never reaches the humorizer (`humorized: false` here), but
    // it MUST still get the chat's words.
    expect(classifySlangDecision({ ...opts, humorized: false })).toBe('sent');
  });

  it('skips a reply the humorizer already rewrote (slang rode along there)', async () => {
    const { classifySlangDecision } = await import('../src/llm/slang.js');
    expect(classifySlangDecision({ ...opts, humorized: true })).toBe('humorized');
  });

  it('skips text its producer already toned (spending digest)', async () => {
    const { classifySlangDecision } = await import('../src/llm/slang.js');
    expect(classifySlangDecision({ ...opts, toned: true })).toBe('already-toned');
  });

  it('skips when slang is off for the chat, and when nothing was learned', async () => {
    const { classifySlangDecision } = await import('../src/llm/slang.js');
    expect(classifySlangDecision({ ...opts, enabled: false })).toBe('slang-disabled');
    expect(classifySlangDecision({ ...opts, lexiconSize: 0 })).toBe('no-lexicon');
  });
});

describe('factsPreserved', () => {
  beforeEach(() => {
    vi.resetModules();
    setEnv({ OPENAI_API_KEY: 'sk-test' });
  });

  it('accepts a pure wording change', async () => {
    const { factsPreserved } = await import('../src/llm/slang.js');
    expect(
      factsPreserved('Игра начнётся в 20:00, победа будет лёгкой.', 'Катка в 20:00, победа изи.'),
    ).toBe(true);
  });

  it('rejects a changed number', async () => {
    const { factsPreserved } = await import('../src/llm/slang.js');
    expect(factsPreserved('Стоит 2700 золота.', 'Стоит 2750 золота, бро.')).toBe(false);
  });

  it('rejects a dropped or invented number', async () => {
    const { factsPreserved } = await import('../src/llm/slang.js');
    expect(factsPreserved('Кулдаун 12 сек, урон 300.', 'Кулдаун 12 сек.')).toBe(false);
    expect(factsPreserved('Кулдаун 12 сек.', 'Кулдаун 12 сек, урон 300.')).toBe(false);
  });

  it('rejects a mangled link or @username', async () => {
    const { factsPreserved } = await import('../src/llm/slang.js');
    expect(
      factsPreserved('Смотри https://a.example/x', 'Смотри https://a.example/y'),
    ).toBe(false);
    expect(factsPreserved('Зову @vasya', 'Зову @vasyan')).toBe(false);
  });

  it('treats 1,5 and 1.5 as the same number (decimal comma)', async () => {
    const { factsPreserved } = await import('../src/llm/slang.js');
    expect(factsPreserved('Волны 1,5 м', 'Волны 1.5 м, изи')).toBe(true);
  });

  it('ignores digits that live inside a URL', async () => {
    const { factsPreserved } = await import('../src/llm/slang.js');
    expect(
      factsPreserved('Сеанс тут https://kino.example/id42', 'Катка тут https://kino.example/id42'),
    ).toBe(true);
  });
});

describe('applySlang / applySlangOrOriginal', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to chat/completions with the lexicon in the system prompt', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_HUMOR_MODEL: 'gpt-5-mini' });
    const fetchMock = vi.fn(async () => completion('  Катка в 20:00  '));
    vi.stubGlobal('fetch', fetchMock);

    const { applySlang } = await import('../src/llm/slang.js');
    const out = await applySlang('Игра в 20:00', [{ term: 'катка', gloss: 'игра' }]);

    expect(out).toBe('Катка в 20:00');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gpt-5-mini');
    expect(body.messages[0].content).toContain('«катка» — игра');
    expect(body.messages[1].content).toBe('Игра в 20:00');
  });

  it('throws without a key', async () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const { applySlang } = await import('../src/llm/slang.js');
    await expect(applySlang('x', [{ term: 'катка', gloss: '' }])).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('falls back to the original when the request fails', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { applySlangOrOriginal } = await import('../src/llm/slang.js');
    expect(await applySlangOrOriginal('Точный ответ', [{ term: 'катка', gloss: '' }])).toBe(
      'Точный ответ',
    );
  });

  it('discards a rewrite that changed a fact', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    const fetchMock = vi.fn(async () => completion('Стоит 2750 золота, бро'));
    vi.stubGlobal('fetch', fetchMock);
    const { applySlangOrOriginal } = await import('../src/llm/slang.js');
    expect(
      await applySlangOrOriginal('Стоит 2700 золота', [{ term: 'бро', gloss: 'друг' }]),
    ).toBe('Стоит 2700 золота');
  });

  it('makes no call at all when the lexicon is empty or the pass is off', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    const fetchMock = vi.fn(async () => completion('rewritten'));
    vi.stubGlobal('fetch', fetchMock);
    let mod = await import('../src/llm/slang.js');
    expect(await mod.applySlangOrOriginal('Точный ответ', [])).toBe('Точный ответ');
    expect(fetchMock).not.toHaveBeenCalled();

    vi.resetModules();
    setEnv({ OPENAI_API_KEY: 'sk-test', ENABLE_SLANG: 'false' });
    mod = await import('../src/llm/slang.js');
    expect(await mod.applySlangOrOriginal('Точный ответ', [{ term: 'катка', gloss: '' }])).toBe(
      'Точный ответ',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
