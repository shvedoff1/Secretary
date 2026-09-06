import { describe, it, expect, vi, beforeEach } from 'vitest';

// The advice block is prose the user reads and acts on before a flight, so it
// is written by the PRECISE tier (ANTHROPIC_PRECISE_MODEL, Opus by default) —
// on Haiku it invented airport terminals. ANTHROPIC_CALENDAR_MODEL only
// overrides. Thinking is left to the model's default (adaptive on Opus 5) with
// max_tokens sized for it.

const createMock = vi.fn(async () => ({ content: [{ type: 'text', text: 'выезжай к 18:00' }] }));
vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

async function load(env: Record<string, string | undefined>) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  delete process.env.ANTHROPIC_CALENDAR_MODEL;
  delete process.env.ANTHROPIC_PRECISE_MODEL;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import('../src/llm/calendarAdvice.js');
}

beforeEach(() => createMock.mockClear());

describe('calendar advice model', () => {
  it('defaults to the precise tier (Opus), never the cheap one', async () => {
    const { calendarAdviceLine, adviceModel, ADVICE_MAX_TOKENS } = await load({
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_PRECISE_MODEL: undefined,
    });
    expect(
      adviceModel({ ANTHROPIC_PRECISE_MODEL: 'claude-opus-5', ANTHROPIC_CALENDAR_MODEL: undefined }),
    ).toBe('claude-opus-5');
    await calendarAdviceLine({ noticeText: '🗓 …', kind: 'morning', hasEarly: false, funny: false });
    const req = createMock.mock.calls[0]![0] as { model: string; max_tokens: number; thinking?: unknown };
    expect(req.model).toBe('claude-opus-5');
    expect(req.model).not.toMatch(/haiku/i);
    // Adaptive thinking is the model default — no explicit `thinking`, and the
    // token budget leaves room for it above the short visible answer.
    expect(req.thinking).toBeUndefined();
    expect(req.max_tokens).toBe(ADVICE_MAX_TOKENS);
    expect(ADVICE_MAX_TOKENS).toBeGreaterThanOrEqual(2048);
  });

  it('follows the precise-tier knob', async () => {
    const { calendarAdviceLine } = await load({ ANTHROPIC_PRECISE_MODEL: 'claude-opus-4-8' });
    await calendarAdviceLine({ noticeText: '🗓 …', kind: 'morning', hasEarly: false, funny: false });
    expect((createMock.mock.calls[0]![0] as { model: string }).model).toBe('claude-opus-4-8');
  });

  it('honours an explicit override', async () => {
    const { calendarAdviceLine } = await load({
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_CALENDAR_MODEL: 'claude-opus-5',
    });
    await calendarAdviceLine({ noticeText: '🗓 …', kind: 'morning', hasEarly: false, funny: false });
    expect((createMock.mock.calls[0]![0] as { model: string }).model).toBe('claude-opus-5');
  });
});
