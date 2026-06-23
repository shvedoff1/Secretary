import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

import { parseLexiconJson, extractLexicon } from '../src/llm/lexicon.js';
import { shouldExtract } from '../src/bot/flows/lexicon.js';

beforeEach(() => {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  createMock.mockReset();
});

describe('parseLexiconJson', () => {
  it('parses a bare JSON array', () => {
    const out = parseLexiconJson('[{"term":"тип","gloss":"типа"}]');
    expect(out).toEqual([{ term: 'тип', gloss: 'типа' }]);
  });

  it('extracts the array even when wrapped in prose/fences', () => {
    const out = parseLexiconJson('Here you go:\n```json\n[{"term":"братик","gloss":""}]\n```');
    expect(out).toEqual([{ term: 'братик', gloss: '' }]);
  });

  it('trims terms, drops blank/invalid entries, defaults gloss to empty', () => {
    const out = parseLexiconJson(
      '[{"term":"  кек  ","gloss":"смешно"},{"term":"  "},{"gloss":"x"},{"term":"го"}]',
    );
    expect(out).toEqual([
      { term: 'кек', gloss: 'смешно' },
      { term: 'го', gloss: '' },
    ]);
  });

  it('returns [] for non-arrays, malformed JSON, or no array at all', () => {
    expect(parseLexiconJson('not json')).toEqual([]);
    expect(parseLexiconJson('{"term":"x"}')).toEqual([]);
    expect(parseLexiconJson('[oops')).toEqual([]);
  });

  it('caps the number of returned terms', () => {
    const many = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ term: `t${i}`, gloss: '' })),
    );
    expect(parseLexiconJson(many, 25)).toHaveLength(25);
  });
});

describe('extractLexicon', () => {
  it('returns [] without calling the model for an empty batch', async () => {
    expect(await extractLexicon([])).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('parses terms from the model reply', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '[{"term":"тип","gloss":"типа"}]' }],
    });
    expect(await extractLexicon(['тип здарова'])).toEqual([
      { term: 'тип', gloss: 'типа' },
    ]);
  });

  it('swallows API errors and returns []', async () => {
    createMock.mockRejectedValue(new Error('overloaded'));
    expect(await extractLexicon(['msg'])).toEqual([]);
  });
});

describe('shouldExtract', () => {
  const opts = { batchSize: 30, maxAgeMs: 24 * 3_600_000 };
  const now = 1_000_000_000_000;

  it('never fires on an empty buffer', () => {
    expect(shouldExtract({ count: 0, oldestAt: null }, opts, now)).toBe(false);
  });

  it('fires once the buffer reaches the batch size', () => {
    expect(shouldExtract({ count: 29, oldestAt: now }, opts, now)).toBe(false);
    expect(shouldExtract({ count: 30, oldestAt: now }, opts, now)).toBe(true);
  });

  it('fires when the oldest sample has aged past the max, even below batch size', () => {
    const old = now - opts.maxAgeMs;
    expect(shouldExtract({ count: 3, oldestAt: old + 1 }, opts, now)).toBe(false);
    expect(shouldExtract({ count: 3, oldestAt: old }, opts, now)).toBe(true);
  });
});
