import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The forward batch: the per-chat pack of forwarded messages waiting for the
// user's ask (or a tap on the 🫡 mark). Transient in-memory state with a sliding
// TTL, a size cap, and a rendered block whose exact shape the model relies on.

async function load(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.FORWARD_BUFFER_TTL_MINUTES;
  delete process.env.FORWARD_BUFFER_MAX;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return import('../src/bot/forwardBuffer.js');
}

function entry(messageId: number, text = `сообщение ${messageId}`) {
  return { messageId, origin: 'Вася', kind: 'text' as const, text };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('forward buffer state', () => {
  it('collects entries per chat and drains them once', async () => {
    const fb = await load();
    fb.bufferForward(1, entry(10));
    fb.bufferForward(1, entry(11));
    fb.bufferForward(2, entry(12));

    expect(fb.bufferedCount(1)).toBe(2);
    expect(fb.isBufferedMessage(1, 10)).toBe(true);
    expect(fb.isBufferedMessage(1, 12)).toBe(false); // other chat's message

    const drained = fb.takeForwards(1);
    expect(drained.entries.map((e) => e.messageId)).toEqual([10, 11]);
    expect(drained.overflow).toBe(0);
    // Drained means gone; the other chat is untouched.
    expect(fb.takeForwards(1).entries).toEqual([]);
    expect(fb.bufferedCount(2)).toBe(1);
    fb.resetForwardBuffers();
  });

  it('caps the pack and counts the overflow', async () => {
    const fb = await load({ FORWARD_BUFFER_MAX: '2' });
    expect(fb.bufferForward(1, entry(1))).toBe(true);
    expect(fb.bufferForward(1, entry(2))).toBe(true);
    expect(fb.bufferForward(1, entry(3))).toBe(false);

    const { entries, overflow } = fb.takeForwards(1);
    expect(entries).toHaveLength(2);
    expect(overflow).toBe(1);
    fb.resetForwardBuffers();
  });

  it('expires an unclaimed pack after the TTL, sliding from the last forward', async () => {
    const fb = await load({ FORWARD_BUFFER_TTL_MINUTES: '10' });
    fb.bufferForward(1, entry(1));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    // A new forward re-arms the clock — the pack survives past the original mark.
    fb.bufferForward(1, entry(2));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(fb.bufferedCount(1)).toBe(2);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fb.bufferedCount(1)).toBe(0);
    fb.resetForwardBuffers();
  });

  it('clears the reaction marks best-effort, surviving a failed removal', async () => {
    const fb = await load();
    const calls: number[] = [];
    const api = {
      setMessageReaction: vi.fn(async (_chat: number, messageId: number) => {
        calls.push(messageId);
        if (messageId === 2) throw new Error('message was deleted');
      }),
    };
    await fb.clearMarks(api as never, 1, [entry(1), entry(2), entry(3)]);
    expect(calls).toEqual([1, 2, 3]); // the failure didn't stop the sweep
  });
});

describe('renderForwardBatch', () => {
  it('numbers the entries and names each origin and channel', async () => {
    const fb = await load();
    const block = fb.renderForwardBatch(
      [
        { messageId: 1, origin: 'Вася', kind: 'text', text: 'погнали в бар' },
        { messageId: 2, origin: 'канал «Новости»', kind: 'voice', text: 'всем привет' },
        { messageId: 3, origin: 'Петя', kind: 'photo', text: '' },
      ],
      0,
    );
    expect(block).toContain('Пересланная пачка — 3 сообщений');
    expect(block).toContain('1. (Вася) погнали в бар');
    expect(block).toContain('2. (канал «Новости», голосовое — расшифровка) всем привет');
    expect(block).toContain('3. (Петя, фото) (фото без подписи)');
    expect(block).toContain('ЧУЖИЕ слова');
  });

  it('admits when part of the pack was dropped over the cap', async () => {
    const fb = await load();
    const block = fb.renderForwardBatch([entry(1)], 4);
    expect(block).toContain('ещё 4 сообщений не поместилось');
  });

  it('announces each picture state: attached (with its number), failed, over-cap', async () => {
    const fb = await load();
    const photo = (messageId: number, text = '') => ({
      messageId,
      origin: 'Петя',
      kind: 'photo' as const,
      text,
      image: { fileId: `f${messageId}`, mediaType: 'image/jpeg' as const },
    });
    const block = fb.renderForwardBatch(
      [photo(1, 'смотри что нашёл'), photo(2), photo(3)],
      0,
      new Map<number, import('../src/bot/forwardBuffer.js').ForwardImageState>([
        [0, { attached: 1 }],
        [1, 'failed'],
        [2, 'skipped'],
      ]),
    );
    expect(block).toContain('1. (Петя, фото) смотри что нашёл [картинка приложена ниже: изображение 1]');
    expect(block).toContain('2. (Петя, фото) (фото без подписи) [картинку скачать не удалось — есть только подпись]');
    expect(block).toContain('3. (Петя, фото) (фото без подписи) [картинка не приложена — лимит картинок на пачку]');
    expect(block).toContain('Приложенные картинки идут сразу после этого блока');
  });

  it('renders exactly as before when no picture states are passed', async () => {
    const fb = await load();
    const block = fb.renderForwardBatch(
      [{ messageId: 1, origin: 'Петя', kind: 'photo', text: '' }],
      0,
    );
    expect(block).toContain('1. (Петя, фото) (фото без подписи)');
    expect(block).not.toContain('картинка');
  });
});
