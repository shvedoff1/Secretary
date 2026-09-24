import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SYSTEM_PROMPT, TUTOR_SYSTEM_PROMPT } from '../src/llm/prompts.js';
import { looksLikeRefusal, rewriteRefused } from '../src/llm/refusal.js';

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ADMIN_TELEGRAM_ID: '123',
};

function setEnv(extra: Record<string, string | undefined>): void {
  for (const k of ['OPENAI_API_KEY', 'ENABLE_HUMOR', 'ENABLE_SLANG']) delete process.env[k];
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

// The bot once refused to retell a crude prison anecdote in an adults' chat.
// Pin the prompt section so the latitude can't silently disappear.
describe('SYSTEM_PROMPT adult humour', () => {
  it('lets the model tell crude jokes and anecdotes without refusing', () => {
    expect(SYSTEM_PROMPT).toContain('Adult humour and folklore');
    expect(SYSTEM_PROMPT).toContain('мат');
    expect(SYSTEM_PROMPT).toMatch(/No refusals/);
  });

  it('keeps the hard limits', () => {
    expect(SYSTEM_PROMPT).toMatch(/nothing sexual involving minors/);
  });

  it('does not leak into the tutor prompt (a kid\'s chat)', () => {
    expect(TUTOR_SYSTEM_PROMPT).not.toContain('Adult humour');
  });
});

describe('looksLikeRefusal / rewriteRefused', () => {
  it.each([
    'Извините, но я не могу помочь с этим.',
    'К сожалению, я не могу переписать этот текст.',
    'Я не могу пересказать такой анекдот.',
    "I'm sorry, but I can't help with that.",
    "Sorry, I can't assist with this request.",
    'I cannot rewrite this content.',
  ])('flags %s', (t) => {
    expect(looksLikeRefusal(t)).toBe(true);
  });

  it.each([
    'Короновали вора в законе. Спрашивают: косяки есть?',
    'изи, бро 🤙 воткнул тебе напоминалку на 18:00',
    'Не могу дождаться выходных, го на сёрф',
    'Катка в 20:00, не опаздывай',
  ])('does not flag %s', (t) => {
    expect(looksLikeRefusal(t)).toBe(false);
  });

  it('only counts a refusal the rewrite INTRODUCED', () => {
    expect(rewriteRefused('Анекдот: …', 'Извините, я не могу помочь с этим.')).toBe(true);
    expect(
      rewriteRefused('К сожалению, я не могу это сделать.', 'Извини, бро, я не могу это сделать.'),
    ).toBe(false);
  });
});

describe('tone passes fall back to the original on a refusal', () => {
  const joke = 'Короновали вора в законе. Спрашивают: косяки есть? — Есть один…';

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('humorizer ships the original joke, not the refusal', async () => {
    setEnv({ ENABLE_HUMOR: 'true', OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => completion("I'm sorry, but I can't help with that.")));
    const { humorizeOrOriginal } = await import('../src/llm/humorize.js');
    expect(await humorizeOrOriginal(joke)).toBe(joke);
  });

  it('humorizer prompt carries the adult-chat note for every persona', async () => {
    const { buildHumorSystemPrompt, HUMOR_ADULT_CONTENT_NOTE } = await import(
      '../src/llm/humorize.js'
    );
    for (const p of [undefined, 'dota', 'funny', { custom: 'дворецкий' }] as const) {
      expect(buildHumorSystemPrompt([], p)).toContain(HUMOR_ADULT_CONTENT_NOTE);
    }
  });

  it('slang pass ships the original joke, not the refusal', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => completion('Извините, я не могу помочь с этим.')));
    const { applySlangOrOriginal } = await import('../src/llm/slang.js');
    expect(await applySlangOrOriginal(joke, [{ term: 'катка', gloss: 'игра' }])).toBe(joke);
  });
});
