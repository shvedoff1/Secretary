import { describe, it, expect } from 'vitest';
import { searchMemory, scoreItem, tokenize } from '../src/util/memorySearch.js';
import type { WeightedItem } from '../src/util/memoryWeight.js';

const NOW = Date.parse('2026-08-16T00:00:00Z');
const DAY = 86_400_000;

function item(over: Partial<WeightedItem> & { id: number; content: string }): WeightedItem {
  return {
    scope: 'chat',
    tgUserId: null,
    subject: '',
    importance: 3,
    reinforce: 0,
    source: 'passive',
    lastSeen: NOW,
    ...over,
  };
}

const OPTS = { limit: 10, now: NOW, halfLifeDays: 14 };

describe('tokenize', () => {
  it('folds case, ё and punctuation the way dedup does', () => {
    expect(tokenize('Ёлка, ПРИВЕТ!')).toEqual(['елка', 'привет']);
  });

  it('drops noise tokens too short to carry signal', () => {
    expect(tokenize('я и он в доме')).toEqual(['доме']);
  });
});

describe('scoreItem', () => {
  it('ranks an exact word above a prefix above a shared stem', () => {
    const exact = scoreItem(['серфинг'], 'любит серфинг')!;
    const prefix = scoreItem(['серфинг'], 'любит серфинговый лагерь')!;
    const stem = scoreItem(['машина'], 'продал машину')!;
    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(stem.score);
  });

  it('returns null when nothing matches, so a non-hit is never surfaced', () => {
    expect(scoreItem(['аллергия'], 'играет в доту по вечерам')).toBeNull();
  });

  it('does not let a short query token match a longer unrelated word', () => {
    // "про" must not prefix-match "программа" — that would make every query hit.
    expect(scoreItem(['про'], 'пишет программа')).toBeNull();
  });
});

describe('searchMemory', () => {
  const ITEMS = [
    item({ id: 1, content: 'У Гоши аллергия на орехи' }),
    item({ id: 2, content: 'Андрей катает серфинг в Веддуре' }),
    item({ id: 3, content: 'Пароль от вайфая в доме — surfhouse2024' }),
    item({
      id: 4,
      scope: 'user',
      tgUserId: 42,
      subject: 'Гоша',
      content: 'день рождения 3 марта',
    }),
  ];

  it('finds a fact by its content words', () => {
    const hits = searchMemory(ITEMS, 'аллергия орехи', OPTS);
    expect(hits[0]?.item.id).toBe(1);
  });

  it('ranks a fact matching more query words first', () => {
    const hits = searchMemory(ITEMS, 'пароль вайфай', OPTS);
    expect(hits[0]?.item.id).toBe(3);
  });

  it('searches the subject too, so a name finds that person\'s facts', () => {
    // The content never repeats "Гоша" — only the subject carries it.
    const hits = searchMemory(ITEMS, 'Гоша день рождения', OPTS);
    expect(hits[0]?.item.id).toBe(4);
  });

  it('narrows to one person with `about`', () => {
    const hits = searchMemory(ITEMS, '', { ...OPTS, about: 'Гоша' });
    // With no query, "everything about X" is the answer — ranked by weight.
    expect(hits.map((h) => h.item.id)).toEqual([4]);
  });

  it('lets relevance beat weight — the point of the deep tier', () => {
    // A stale, decayed fact that actually answers the question must outrank a fresh,
    // heavily reinforced one that merely shares a word; otherwise the search returns
    // the same thing the always-injected working set already had.
    const items = [
      item({ id: 10, content: 'сегодня играли в доту', reinforce: 20, lastSeen: NOW }),
      item({
        id: 11,
        content: 'у Иры аллергия на пенициллин',
        importance: 2,
        lastSeen: NOW - 120 * DAY,
      }),
    ];
    const hits = searchMemory(items, 'аллергия пенициллин', OPTS);
    expect(hits[0]?.item.id).toBe(11);
  });

  it('returns nothing for a query with no usable tokens', () => {
    expect(searchMemory(ITEMS, '?! ??', OPTS)).toEqual([]);
    expect(searchMemory(ITEMS, '', OPTS)).toEqual([]);
  });

  it('honours the limit and stays stable across identical calls', () => {
    const first = searchMemory(ITEMS, 'в доме', { ...OPTS, limit: 1 });
    const second = searchMemory(ITEMS, 'в доме', { ...OPTS, limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0]?.item.id).toBe(second[0]?.item.id);
  });
});
