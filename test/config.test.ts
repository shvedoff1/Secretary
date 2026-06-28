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

  it('defaults to claude-sonnet-4-6 when unset', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().ANTHROPIC_MODEL).toBe('claude-sonnet-4-6');
  });

  it('honours an explicit override', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().ANTHROPIC_MODEL).toBe('claude-opus-4-8');
  });
});
