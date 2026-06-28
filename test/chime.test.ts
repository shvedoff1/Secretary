import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// The chime only orchestrates timing + context; the actual reply path is mocked so
// we can assert WHAT it would send and WHEN, without an LLM or Telegram.
const runMock = vi.fn(async () => 'replied' as const);
vi.mock('../src/bot/flows/assist.js', () => ({
  runAndRespond: runMock,
}));

type ChimeModule = typeof import('../src/bot/flows/chime.js');

async function load(env: Record<string, string> = {}): Promise<ChimeModule> {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  // Default: always arm (prob 1) and a short, deterministic quiet window.
  process.env.CHIME_PROBABILITY = '1';
  process.env.CHIME_QUIET_SECONDS = '60';
  delete process.env.ENABLE_CHIME;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return import('../src/bot/flows/chime.js');
}

function ctx(chatId = 1): Context {
  return { chat: { id: chatId, type: 'group' }, from: { id: 2 }, message: {} } as unknown as Context;
}

const QUIET_MS = 60_000;

beforeEach(() => {
  runMock.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ['CHIME_PROBABILITY', 'CHIME_QUIET_SECONDS', 'ENABLE_CHIME']) delete process.env[k];
});

describe('chime scheduling', () => {
  it('fires after the quiet window with the recent chatter as context', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'го серфить завтра');
    chime.recordChatMessage(1, 'Петя', 'я за');
    chime.maybeScheduleChime(ctx());

    expect(runMock).not.toHaveBeenCalled(); // not immediate — waits for the lull
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(runMock).toHaveBeenCalledOnce();
    const args = runMock.mock.calls[0]![1] as { addressed: boolean; userContent: string };
    expect(args.addressed).toBe(true); // replies as if pinged
    expect(args.userContent).toContain('Аня: го серфить завтра');
    expect(args.userContent).toContain('Петя: я за');
  });

  it('does not arm when the probability roll loses', async () => {
    const chime = await load({ CHIME_PROBABILITY: '0.1' });
    chime.recordChatMessage(1, 'Аня', 'привет');
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // >= 0.1 → skip
    chime.maybeScheduleChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('cancels a pending chime when a new message arrives within the window', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'кто дома?');
    chime.maybeScheduleChime(ctx());

    // Someone speaks again before the lull elapses → the chat is still active.
    await vi.advanceTimersByTimeAsync(QUIET_MS / 2);
    chime.cancelChime(1);
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(runMock).not.toHaveBeenCalled();
  });

  it('re-arming resets the silence clock to the latest message', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'раз');
    chime.maybeScheduleChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS - 1000);
    // A new message lands: cancel (as the middleware does) then re-arm on it.
    chime.cancelChime(1);
    chime.recordChatMessage(1, 'Петя', 'два');
    chime.maybeScheduleChime(ctx());

    // The original deadline passes — must NOT fire, the clock restarted.
    await vi.advanceTimersByTimeAsync(2000);
    expect(runMock).not.toHaveBeenCalled();

    // Only after a full fresh quiet window does it fire.
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('does nothing when chime is disabled', async () => {
    const chime = await load({ ENABLE_CHIME: 'false' });
    chime.recordChatMessage(1, 'Аня', 'привет');
    chime.maybeScheduleChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('does not fire if the chat has no recorded chatter', async () => {
    const chime = await load();
    chime.maybeScheduleChime(ctx(99)); // armed but buffer empty
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).not.toHaveBeenCalled();
  });
});
