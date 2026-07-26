import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Context } from 'grammy';
import { maybeAutoReact, POSITIVE_REACTIONS } from '../src/bot/reactions.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeCtx(opts: { text?: string; react?: Context['react'] }): Context {
  return {
    message: opts.text === undefined ? {} : { text: opts.text },
    react: opts.react ?? vi.fn(async () => {}),
  } as unknown as Context;
}

describe('maybeAutoReact', () => {
  it('reacts with a positive emoji when the 10% roll passes', async () => {
    const react = vi.fn(async () => {});
    // First random() = probability roll (0.05 < 0.1 → react); second = emoji index.
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.05).mockReturnValueOnce(0);
    await maybeAutoReact(fakeCtx({ text: 'привет', react }));
    expect(react).toHaveBeenCalledOnce();
    expect(POSITIVE_REACTIONS).toContain(react.mock.calls[0]?.[0]);
  });

  it('picks the emoji by index from the random draw', async () => {
    const react = vi.fn(async () => {});
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    await maybeAutoReact(fakeCtx({ text: 'yo', react }));
    expect(react).toHaveBeenCalledWith(POSITIVE_REACTIONS[POSITIVE_REACTIONS.length - 1]);
  });

  it('does nothing when the 10% roll fails', async () => {
    const react = vi.fn(async () => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // >= 0.1 → skip
    await maybeAutoReact(fakeCtx({ text: 'привет', react }));
    expect(react).not.toHaveBeenCalled();
  });

  it('skips slash-commands even if the roll would pass', async () => {
    const react = vi.fn(async () => {});
    vi.spyOn(Math, 'random').mockReturnValue(0); // would react if not a command
    await maybeAutoReact(fakeCtx({ text: '/help', react }));
    expect(react).not.toHaveBeenCalled();
  });

  it('reacts to non-text messages (stickers/photos) too', async () => {
    const react = vi.fn(async () => {});
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);
    await maybeAutoReact(fakeCtx({ text: undefined, react }));
    expect(react).toHaveBeenCalledOnce();
  });

  it('swallows reaction errors (best-effort)', async () => {
    const react = vi.fn(async () => {
      throw new Error('reactions disabled');
    });
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);
    await expect(maybeAutoReact(fakeCtx({ text: 'yo', react }))).resolves.toBeUndefined();
  });

  it('only lists positive reactions (no negative ones)', () => {
    const negatives = ['👎', '💩', '🤮', '🖕', '😡', '🤬', '💔', '😭'];
    for (const n of negatives) {
      expect(POSITIVE_REACTIONS as readonly string[]).not.toContain(n);
    }
  });
});

// The per-chat toggle needs the DB (chat_settings), so these tests migrate an
// in-memory database and load the module fresh — unlike the pure tests above.
describe('maybeAutoReact per-chat toggle', () => {
  async function loadWithDb() {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();
    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    const reactions = await import('../src/bot/reactions.js');
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    const { closeDb } = await import('../src/db/client.js');
    return { reactions, settings, closeDb };
  }

  function chatCtx(chatId: number, react: Context['react']): Context {
    return {
      chat: { id: chatId, type: 'group' },
      message: { text: 'привет' },
      react,
    } as unknown as Context;
  }

  it('never reacts in a chat with reactions switched off, others unaffected', async () => {
    const { reactions, settings, closeDb } = await loadWithDb();
    try {
      settings.setReactionsEnabled(5, false);
      vi.spyOn(Math, 'random').mockReturnValue(0); // roll always passes
      const muted = vi.fn(async () => {});
      await reactions.maybeAutoReact(chatCtx(5, muted));
      expect(muted).not.toHaveBeenCalled();

      const free = vi.fn(async () => {});
      await reactions.maybeAutoReact(chatCtx(6, free));
      expect(free).toHaveBeenCalledOnce();

      settings.setReactionsEnabled(5, true);
      const back = vi.fn(async () => {});
      await reactions.maybeAutoReact(chatCtx(5, back));
      expect(back).toHaveBeenCalledOnce();
    } finally {
      closeDb();
    }
  });
});
