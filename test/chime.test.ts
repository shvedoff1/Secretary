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
  // fireChime reads the chat's mode (dota chats get the tactic instruction), so
  // the chat_settings table must exist even for the plain scheduling tests.
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
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
afterEach(async () => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  const { closeDb } = await import('../src/db/client.js');
  closeDb();
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

describe('per-chat chime toggle', () => {
  it('a chat with chime disabled never fires, other chats are unaffected', async () => {
    const chime = await load();
    const { setChimeEnabled } = await import('../src/db/repos/chatSettings.repo.js');
    setChimeEnabled(1, false);

    chime.recordChatMessage(1, 'Аня', 'тишина будет долгой');
    chime.recordChatMessage(2, 'Петя', 'а тут можно');
    chime.armChime(ctx(1));
    chime.armChime(ctx(2));
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    // Only chat 2 chimed; the silenced chat stayed silent.
    expect(runMock).toHaveBeenCalledOnce();
    const usedCtx = runMock.mock.calls[0]![0] as { chat: { id: number } };
    expect(usedCtx.chat.id).toBe(2);
  });

  it('re-enabling brings the chime back', async () => {
    const chime = await load();
    const { setChimeEnabled } = await import('../src/db/repos/chatSettings.repo.js');
    setChimeEnabled(1, false);
    setChimeEnabled(1, true);
    chime.recordChatMessage(1, 'Аня', 'вернулись');
    chime.armChime(ctx(1));
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(runMock).toHaveBeenCalledOnce();
  });
});

describe('per-mode chime stance', () => {
  it('a chat set up as the calm assistant never chimes, however long the silence', async () => {
    const chime = await load();
    const { setChatMode } = await import('../src/db/repos/chatSettings.repo.js');
    const { applyModeDefaults, modeSpec } = await import('../src/modes.js');
    // Picking the calm preset writes chime_disabled into the chat's switches —
    // that switch (not the mode itself) is what keeps the chat quiet.
    setChatMode(1, 'assistant');
    applyModeDefaults(1, modeSpec('assistant'));

    chime.recordChatMessage(1, 'Аня', 'тишина');
    chime.recordChatMessage(2, 'Петя', 'а тут можно');
    chime.armChime(ctx(1));
    chime.armChime(ctx(2));
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    // Only the secretary chat chimed — the assistant one has no business butting in.
    expect(runMock).toHaveBeenCalledOnce();
    const usedCtx = runMock.mock.calls[0]![0] as { chat: { id: number } };
    expect(usedCtx.chat.id).toBe(2);
  });

  it('a tutor chat never chimes either', async () => {
    const chime = await load();
    const { setChatMode } = await import('../src/db/repos/chatSettings.repo.js');
    setChatMode(1, 'tutor');
    chime.recordChatMessage(1, 'Ученик', 'молчание');
    chime.armChime(ctx(1));
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('chime persona (dota mode)', () => {
  it('in a dota chat the chime instruction demands a concrete Dota tactic', async () => {
    const chime = await load();
    const { setChatMode } = await import('../src/db/repos/chatSettings.repo.js');
    setChatMode(1, 'dota');
    chime.recordChatMessage(1, 'Аня', 'ну и катка была вчера');
    chime.armChime(ctx());
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(runMock).toHaveBeenCalledOnce();
    const { userContent } = runMock.mock.calls[0]![1] as { userContent: string };
    expect(userContent).toContain('Dota 2');
    expect(userContent).toMatch(/тактику/);
    // The revive framing stays — it's still a chime, just with a lesson attached.
    expect(userContent).toContain('рофл');
  });

  it('a secretary chat gets the plain revive with no dota tactic', async () => {
    const chime = await load();
    chime.recordChatMessage(1, 'Аня', 'ну и катка была вчера');
    chime.armChime(ctx());
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    const { userContent } = runMock.mock.calls[0]![1] as { userContent: string };
    expect(userContent).not.toContain('Dota 2');
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
