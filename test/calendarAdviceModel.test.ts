import { describe, it, expect, vi, beforeEach } from 'vitest';

// The advice block is prose the user reads and acts on, so it is written by the
// MAIN model like every other user-facing reply — on Haiku it invented airport
// terminals. ANTHROPIC_CALENDAR_MODEL only overrides; unset = ANTHROPIC_MODEL.

const createMock = vi.fn(async () => ({ content: [{ type: 'text', text: 'выезжай к 18:00' }] }));
vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

async function load(env: Record<string, string | undefined>) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  delete process.env.ANTHROPIC_CALENDAR_MODEL;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import('../src/llm/calendarAdvice.js');
}

beforeEach(() => createMock.mockClear());

describe('calendar advice model', () => {
  it('defaults to the main model, never the cheap tier', async () => {
    const { calendarAdviceLine, adviceModel } = await load({ ANTHROPIC_MODEL: 'claude-sonnet-5' });
    expect(adviceModel({ ANTHROPIC_MODEL: 'claude-sonnet-5', ANTHROPIC_CALENDAR_MODEL: undefined })).toBe('claude-sonnet-5');
    await calendarAdviceLine({ noticeText: '🗓 …', kind: 'morning', hasEarly: false, funny: false });
    const req = createMock.mock.calls[0]![0] as { model: string };
    expect(req.model).toBe('claude-sonnet-5');
    expect(req.model).not.toMatch(/haiku/i);
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
