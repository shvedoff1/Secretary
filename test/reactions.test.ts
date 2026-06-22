import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Context } from 'grammy';
import { maybeAutoReact } from '../src/bot/reactions.js';

const ANTOHA = 68059142;
const EMOJIS = ['😎', '🔥'];

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeCtx(opts: {
  userId?: number;
  text?: string;
  react?: Context['react'];
}): Context {
  return {
    from: opts.userId === undefined ? undefined : { id: opts.userId },
    message: opts.text === undefined ? {} : { text: opts.text },
    react: opts.react ?? vi.fn(async () => {}),
  } as unknown as Context;
}

describe('maybeAutoReact', () => {
  it('reacts to a configured user with one of their emojis', async () => {
    const react = vi.fn(async () => {});
    await maybeAutoReact(fakeCtx({ userId: ANTOHA, text: 'привет', react }));
    expect(react).toHaveBeenCalledOnce();
    expect(EMOJIS).toContain(react.mock.calls[0]?.[0]);
  });

  it('picks randomly between the configured emojis', async () => {
    const low = vi.fn(async () => {});
    vi.spyOn(Math, 'random').mockReturnValue(0); // first choice
    await maybeAutoReact(fakeCtx({ userId: ANTOHA, text: 'a', react: low }));
    expect(low).toHaveBeenCalledWith('😎');

    const high = vi.fn(async () => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // last choice
    await maybeAutoReact(fakeCtx({ userId: ANTOHA, text: 'b', react: high }));
    expect(high).toHaveBeenCalledWith('🔥');
  });

  it('reacts to non-text messages from the configured user', async () => {
    const react = vi.fn(async () => {});
    // No text (e.g. a sticker/photo) — should still react.
    await maybeAutoReact(fakeCtx({ userId: ANTOHA, text: undefined, react }));
    expect(EMOJIS).toContain(react.mock.calls[0]?.[0]);
  });

  it('does nothing for other users', async () => {
    const react = vi.fn(async () => {});
    await maybeAutoReact(fakeCtx({ userId: 111, text: 'привет', react }));
    expect(react).not.toHaveBeenCalled();
  });

  it('skips slash-commands', async () => {
    const react = vi.fn(async () => {});
    await maybeAutoReact(fakeCtx({ userId: ANTOHA, text: '/help', react }));
    expect(react).not.toHaveBeenCalled();
  });

  it('ignores messages with no sender', async () => {
    const react = vi.fn(async () => {});
    await maybeAutoReact(fakeCtx({ userId: undefined, react }));
    expect(react).not.toHaveBeenCalled();
  });

  it('swallows reaction errors (best-effort)', async () => {
    const react = vi.fn(async () => {
      throw new Error('reactions disabled');
    });
    await expect(
      maybeAutoReact(fakeCtx({ userId: ANTOHA, text: 'yo', react })),
    ).resolves.toBeUndefined();
  });
});
