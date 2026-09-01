import { describe, it, expect, vi, beforeEach } from 'vitest';

// The advice pass trades on real knowledge of places (which airport, how far,
// visa rules) — Haiku answered «до аэропорта 15-20 минут» about the replaced
// Siem Reap airport. It now runs on the MAIN assistant model unless
// ANTHROPIC_CALENDAR_MODEL explicitly picks a cheaper one.

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'x',
  ANTHROPIC_API_KEY: 'x',
  ADMIN_TELEGRAM_ID: '1',
};

const createMock = vi.fn();
vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

function reply(text: string) {
  return { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } };
}

async function adviceModelSent(): Promise<string> {
  createMock.mockResolvedValue(reply('выезжай к 8:30'));
  const { calendarAdviceLine } = await import('../src/llm/calendarAdvice.js');
  await calendarAdviceLine({ noticeText: '09:40 Flight', kind: 'morning', hasEarly: false, funny: false });
  return createMock.mock.calls[0]![0].model;
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  delete process.env.ANTHROPIC_CALENDAR_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  vi.resetModules();
  createMock.mockReset();
});

describe('calendar advice model choice', () => {
  it('defaults to the main assistant model, not a cheap one', async () => {
    expect(await adviceModelSent()).toBe('claude-sonnet-5');
  });

  it('follows a re-pointed main model automatically', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    expect(await adviceModelSent()).toBe('claude-opus-5');
  });

  it('honours an explicit ANTHROPIC_CALENDAR_MODEL override', async () => {
    process.env.ANTHROPIC_CALENDAR_MODEL = 'claude-haiku-4-5-20251001';
    expect(await adviceModelSent()).toBe('claude-haiku-4-5-20251001');
  });
});
