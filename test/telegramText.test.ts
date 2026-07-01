import { describe, it, expect } from 'vitest';
import { splitTelegramMessage, TELEGRAM_MAX_MESSAGE } from '../src/util/telegramText.js';

describe('splitTelegramMessage', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(splitTelegramMessage('hello')).toEqual(['hello']);
    const exact = 'a'.repeat(TELEGRAM_MAX_MESSAGE);
    expect(splitTelegramMessage(exact)).toEqual([exact]);
  });

  it('splits an over-limit message into chunks that each fit', () => {
    const line = 'x'.repeat(50);
    const text = Array.from({ length: 200 }, () => line).join('\n'); // ~10k chars
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    // No content is lost (modulo the whitespace we trim at boundaries).
    expect(chunks.join('\n').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''));
  });

  it('prefers to break on a newline boundary', () => {
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    const chunks = splitTelegramMessage(`${a}\n${b}`);
    expect(chunks).toEqual([a, b]);
  });

  it('hard-splits a single line with no break points', () => {
    const text = 'z'.repeat(TELEGRAM_MAX_MESSAGE + 100);
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(TELEGRAM_MAX_MESSAGE);
    expect(chunks[1]!.length).toBe(100);
  });

  it('respects a custom limit', () => {
    const chunks = splitTelegramMessage('one two three four', 8);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8);
    expect(chunks.join(' ')).toContain('one');
  });
});
