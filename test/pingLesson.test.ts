import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The lesson is generated via OpenAI (the humorizer's model/knobs, plain fetch),
// so the tests stub global fetch — same approach as humorize.test.ts.

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'x',
  ANTHROPIC_API_KEY: 'x',
  ADMIN_TELEGRAM_ID: '1',
};

function setEnv(extra: Record<string, string | undefined> = {}): void {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_HUMOR_MODEL;
  delete process.env.OPENAI_REASONING_EFFORT;
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

/** The JSON body of the sole fetch call. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>): {
  model: string;
  reasoning_effort?: string;
  messages: { role: string; content: string }[];
} {
  const [, init] = fetchMock.mock.calls[0]! as [string, { body: string }];
  return JSON.parse(init.body);
}

async function load() {
  vi.resetModules();
  return import('../src/llm/pingLesson.js');
}

describe('generatePingLesson (OpenAI)', () => {
  beforeEach(() => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the trimmed generated lesson and feeds the recent chat into the prompt', async () => {
    const fetchMock = vi.fn(async () =>
      completion('  Урок: кто спрашивает «когда катка» — тот уже морально на руне 💀  '),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { generatePingLesson } = await load();
    const out = await generatePingLesson([
      { name: 'Вася', text: 'ну что, когда катка?' },
      { name: 'Петя', text: 'я после пар' },
    ]);

    expect(out).toBe('Урок: кто спрашивает «когда катка» — тот уже морально на руне 💀');
    const body = sentBody(fetchMock);
    const user = body.messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain('Вася: ну что, когда катка?');
    expect(user.content).toContain('Петя: я после пар');
  });

  it('uses the humorizer model + reasoning knob (no slow thinking over a bit)', async () => {
    setEnv({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_HUMOR_MODEL: 'gpt-5.5',
      OPENAI_REASONING_EFFORT: 'low',
    });
    const fetchMock = vi.fn(async () => completion('Урок.'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load();
    await mod.generatePingLesson([]);

    const body = sentBody(fetchMock);
    expect(body.model).toBe('gpt-5.5');
    expect(body.reasoning_effort).toBe('low');
  });

  it('puts the canned lessons and format rules into the system prompt', async () => {
    const fetchMock = vi.fn(async () => completion('Урок.'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load();
    await mod.generatePingLesson([]);

    const body = sentBody(fetchMock);
    const system = body.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('Dota 2');
    expect(system).toContain('референсы');
    // A couple of the canned lessons must be present verbatim as examples.
    expect(system).toContain(mod.PING_LESSONS[0]!);
    expect(system).toContain(mod.PING_LESSONS[mod.PING_LESSONS.length - 1]!);
    // The beefed-up format: a 3-4 sentence lesson with zoomer slang and emoji.
    expect(system).toContain('3-4 предложения');
    expect(system).toContain('Эмодзи');
    expect(system).toContain('скилл ишью');
  });

  it('tells the model the chat is quiet when there is no recent chatter', async () => {
    const fetchMock = vi.fn(async () => completion('Урок.'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load();
    await mod.generatePingLesson([]);

    const body = sentBody(fetchMock);
    expect(body.messages.find((m) => m.role === 'user')!.content).toContain('тихо');
  });

  it('defangs any stray @mention in the output so a lesson can never ping', async () => {
    const fetchMock = vi.fn(async () => completion('Урок: @vasya стоит на руне уже минуту.'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load();
    const out = await mod.generatePingLesson([]);
    expect(out).toContain(`@​vasya`);
    expect(out).not.toMatch(/@vasya/);
  });

  it('returns null without calling OpenAI when no key is configured', async () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load();
    await expect(mod.generatePingLesson([])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on an API error (caller falls back to the canned pool)', async () => {
    const fetchMock = vi.fn(async () => new Response('overloaded', { status: 529 }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load();
    await expect(mod.generatePingLesson([])).resolves.toBeNull();
  });

  it('returns null on empty model output', async () => {
    const fetchMock = vi.fn(async () => completion('   '));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load();
    await expect(mod.generatePingLesson([])).resolves.toBeNull();
  });
});
