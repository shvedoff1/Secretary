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
  // Default: always arm (prob 1) and a short, deterministic quiet window. The hour
  // tier is set up but with prob 0 so it never interferes unless a test opts in.
  process.env.CHIME_PROBABILITY = '1';
  process.env.CHIME_QUIET_SECONDS = '60';
  process.env.CHIME_HOUR_SECONDS = '3600';
  process.env.CHIME_HOUR_PROBABILITY = '0';
  delete process.env.ENABLE_CHIME;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return import('../src/bot/flows/chime.js');
}

function ctx(chatId = 1): Context {
  return { chat: { id: chatId, type: 'group' }, from: { id: 2 }, message: {} } as unknown as Context;
}

const QUIET_MS = 60_000;
const HOUR_MS = 3_600_000;

beforeEach(() => {
  runMock.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of [
    'CHIME_PROBABILITY',
    'CHIME_QUIET_SECONDS',
    'CHIME_HOUR_SECONDS',
    'CHIME_HOUR_PROBABILITY',
    'ENABLE_CHIME',
  ]) {
    delete process.env[k];
  }
});

describe('chime scheduling', () => {
  it('rolls only after the quiet window, then fires with recent chatter as context', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'го серфить завтра');
    chime.recordChatMessage(1, 'Петя', 'я за');
    chime.armChime(ctx());

    expect(runMock).not.toHaveBeenCalled(); // not immediate — waits for the lull
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(runMock).toHaveBeenCalledOnce();
    const args = runMock.mock.calls[0]![1] as { addressed: boolean; userContent: string };
    expect(args.addressed).toBe(true); // replies as if pinged
    expect(args.userContent).toContain('Аня: го серфить завтра');
    expect(args.userContent).toContain('Петя: я за');
  });

  it('frames the chime as a silly revive, not an attempt to answer or ask for info', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Антон', 'https://maps.google.com/?q=шава');
    chime.armChime(ctx());
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    const { userContent } = runMock.mock.calls[0]![1] as { userContent: string };
    // It must steer away from Q&A / "send me a pin" behaviour.
    expect(userContent).toContain('рофл');
    expect(userContent).toMatch(/НЕ пытайся ответить/);
    expect(userContent).toMatch(/НЕ проси ничего прислать/);
  });

  it('does not call the LLM at all before the quiet window elapses', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'привет');
    chime.armChime(ctx());

    // Almost the whole window has passed but the lull isn't complete yet — no roll,
    // no LLM call. The point of the inversion: the dice are thrown only after 60s.
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('stays silent when the post-silence roll loses', async () => {
    const chime = await load({ CHIME_PROBABILITY: '0.1' });
    chime.recordChatMessage(1, 'Аня', 'привет');
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // >= 0.1 → roll loses at fire time
    chime.armChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('cancels the pending roll when a new message arrives within the window', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'кто дома?');
    chime.armChime(ctx());

    // Someone speaks again before the lull elapses → the chat is still active.
    await vi.advanceTimersByTimeAsync(QUIET_MS / 2);
    chime.cancelChime(1);
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(runMock).not.toHaveBeenCalled();
  });

  it('re-arming resets the silence clock to the latest message', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'раз');
    chime.armChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS - 1000);
    // A new message lands: cancel (as the middleware does) then re-arm on it.
    chime.cancelChime(1);
    chime.recordChatMessage(1, 'Петя', 'два');
    chime.armChime(ctx());

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
    chime.armChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('does not fire if the chat has no recorded chatter', async () => {
    const chime = await load();
    chime.armChime(ctx(99)); // armed but buffer empty
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('chime hour-tier escalation', () => {
  it('escalates to the hour tier and fires when the 60s roll lost', async () => {
    // First tier never wins (0%), hour tier always wins (1%-> use 1).
    const chime = await load({ CHIME_PROBABILITY: '0', CHIME_HOUR_PROBABILITY: '1' });
    chime.recordChatMessage(1, 'Аня', 'ау, есть кто живой?');
    chime.armChime(ctx());

    // 60s passes: first roll loses, nothing sent yet.
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).not.toHaveBeenCalled();

    // The chat stays dead until the hour mark: now the 60% tier rolls and fires.
    await vi.advanceTimersByTimeAsync(HOUR_MS - QUIET_MS);
    expect(runMock).toHaveBeenCalledOnce();
    const args = runMock.mock.calls[0]![1] as { addressed: boolean; userContent: string };
    expect(args.addressed).toBe(true);
    expect(args.userContent).toContain('Аня: ау, есть кто живой?');
  });

  it('does not escalate once the first tier already fired', async () => {
    // First tier always wins → it fires and must NOT roll again at the hour mark.
    const chime = await load({ CHIME_PROBABILITY: '1', CHIME_HOUR_PROBABILITY: '1' });
    chime.recordChatMessage(1, 'Аня', 'привет');
    chime.armChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(runMock).toHaveBeenCalledOnce(); // still once — no double chime
  });

  it('a new message during the hour wait cancels the escalation', async () => {
    const chime = await load({ CHIME_PROBABILITY: '0', CHIME_HOUR_PROBABILITY: '1' });
    chime.recordChatMessage(1, 'Аня', 'кто тут');
    chime.armChime(ctx());

    await vi.advanceTimersByTimeAsync(QUIET_MS); // first tier loses, hour tier armed
    await vi.advanceTimersByTimeAsync(HOUR_MS / 2);
    chime.cancelChime(1); // someone finally spoke
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(runMock).not.toHaveBeenCalled();
  });
});
