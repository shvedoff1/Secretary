import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// loadConfig caches and reads from process.env, so each case resets modules and
// restores the env it touched.
const REQUIRED_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ADMIN_TELEGRAM_ID: '123',
};

describe('config ANTHROPIC_MODEL', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_MODEL;
  });

  it('defaults to claude-sonnet-5 when unset', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().ANTHROPIC_MODEL).toBe('claude-sonnet-5');
  });

  it('honours an explicit override', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().ANTHROPIC_MODEL).toBe('claude-opus-4-8');
  });
});

describe('config OpenAI humorizer latency knobs', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
    delete process.env.OPENAI_REASONING_EFFORT;
    delete process.env.OPENAI_HUMOR_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.OPENAI_REASONING_EFFORT;
    delete process.env.OPENAI_HUMOR_TIMEOUT_MS;
    delete process.env.OPENAI_HUMOR_MODEL;
  });

  it('defaults reasoning effort to low and timeout to 20s', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.OPENAI_REASONING_EFFORT).toBe('low');
    expect(cfg.OPENAI_HUMOR_TIMEOUT_MS).toBe(20_000);
  });

  it('defaults the humorizer model to gpt-5.5', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().OPENAI_HUMOR_MODEL).toBe('gpt-5.5');
  });

  it('honours explicit overrides', async () => {
    process.env.OPENAI_REASONING_EFFORT = 'none';
    process.env.OPENAI_HUMOR_TIMEOUT_MS = '5000';
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.OPENAI_REASONING_EFFORT).toBe('none');
    expect(cfg.OPENAI_HUMOR_TIMEOUT_MS).toBe(5000);
  });

  it('rejects an invalid reasoning effort', async () => {
    process.env.OPENAI_REASONING_EFFORT = 'ultra';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/OPENAI_REASONING_EFFORT/);
  });
});
