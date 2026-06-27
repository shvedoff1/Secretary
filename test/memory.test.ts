import { describe, it, expect } from 'vitest';
import { parseMemoryJson } from '../src/llm/memory.js';
import { resolveSubject } from '../src/bot/flows/memory.js';

describe('parseMemoryJson', () => {
  it('parses a clean extraction object', () => {
    const out = parseMemoryJson(
      '{"newItems":[{"scope":"user","subject":"Маша","content":"переехала в Лиссабон","importance":4}],"reinforcedIds":[12,7]}',
    );
    expect(out.newItems).toEqual([
      { scope: 'user', subject: 'Маша', content: 'переехала в Лиссабон', importance: 4 },
    ]);
    expect(out.reinforcedIds).toEqual([12, 7]);
  });

  it('salvages an object wrapped in prose / fences', () => {
    const out = parseMemoryJson(
      'Here you go:\n```json\n{"newItems":[{"scope":"chat","content":"едут на Бали","importance":5}],"reinforcedIds":[]}\n```',
    );
    expect(out.newItems).toHaveLength(1);
    expect(out.newItems[0]).toMatchObject({ scope: 'chat', subject: '', content: 'едут на Бали' });
  });

  it('returns an empty result on malformed JSON', () => {
    expect(parseMemoryJson('not json at all')).toEqual({ newItems: [], reinforcedIds: [] });
    expect(parseMemoryJson('{ broken')).toEqual({ newItems: [], reinforcedIds: [] });
  });

  it('skips one bad newItems entry but keeps the rest', () => {
    const out = parseMemoryJson(
      '{"newItems":[{"scope":"chat","content":""},{"scope":"chat","content":"valid","importance":3},{"nope":1}],"reinforcedIds":[]}',
    );
    expect(out.newItems.map((i) => i.content)).toEqual(['valid']);
  });

  it('clamps importance into 1..5 and defaults when missing', () => {
    const out = parseMemoryJson(
      '{"newItems":[{"scope":"chat","content":"a","importance":99},{"scope":"chat","content":"b","importance":-3},{"scope":"chat","content":"c"}],"reinforcedIds":[]}',
    );
    expect(out.newItems.map((i) => i.importance)).toEqual([5, 1, 3]);
  });

  it('defaults reinforcedIds to [] and drops non-integer ids', () => {
    const out = parseMemoryJson('{"newItems":[]}');
    expect(out.reinforcedIds).toEqual([]);
    const out2 = parseMemoryJson('{"newItems":[],"reinforcedIds":[3,"x",1.5,0,-2]}');
    expect(out2.reinforcedIds).toEqual([3]);
  });

  it('drops the subject for chat-scope facts', () => {
    const out = parseMemoryJson(
      '{"newItems":[{"scope":"chat","subject":"Маша","content":"a","importance":2}],"reinforcedIds":[]}',
    );
    expect(out.newItems[0]!.subject).toBe('');
  });
});

describe('resolveSubject', () => {
  const senders = [
    { tgUserId: 1, name: 'Маша Иванова' },
    { tgUserId: 2, name: 'Пётр' },
  ];

  it('resolves an exact name match', () => {
    expect(resolveSubject('Пётр', senders)).toBe(2);
  });

  it('resolves a first-name token of a full sender name', () => {
    expect(resolveSubject('Маша', senders)).toBe(1);
  });

  it('resolves via prefix when the extractor uses the full name', () => {
    expect(resolveSubject('Пётр Сидоров', senders)).toBe(2);
  });

  it('returns null for an unknown subject', () => {
    expect(resolveSubject('Алексей', senders)).toBeNull();
    expect(resolveSubject('', senders)).toBeNull();
  });
});
