import { describe, it, expect } from 'vitest';
import { parseMemoryJson } from '../src/llm/memory.js';
import { resolveSubject } from '../src/bot/flows/memory.js';

describe('parseMemoryJson', () => {
  it('parses a clean extraction object', () => {
    const out = parseMemoryJson(
      '{"newItems":[{"scope":"user","subject":"Маша","content":"переехала в Лиссабон","importance":4}],"reinforcedIds":[12,7]}',
    );
    expect(out.newItems).toEqual([
      // No kind in the model's output → trait, the safe (pre-027) default.
      { scope: 'user', subject: 'Маша', content: 'переехала в Лиссабон', importance: 4, kind: 'trait' },
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
    expect(resolveSubject('Пётр', senders)).toEqual({ tgUserId: 2, subject: 'Пётр' });
  });

  it('resolves a first-name token of a full sender name', () => {
    expect(resolveSubject('Маша', senders)).toEqual({ tgUserId: 1, subject: 'Маша' });
  });

  it('resolves via prefix when the extractor uses the full name', () => {
    expect(resolveSubject('Пётр Сидоров', senders)).toEqual({
      tgUserId: 2,
      subject: 'Пётр Сидоров',
    });
  });

  it('leaves an unknown subject unkeyed, keeping its spelling', () => {
    expect(resolveSubject('Алексей', senders)).toEqual({
      tgUserId: null,
      subject: 'Алексей',
    });
    expect(resolveSubject('', senders)).toEqual({ tgUserId: null, subject: '' });
  });

  // The voice case: a transcript writes «Швец» where the chat means «Швед». Without
  // folding, that opens a person who does not exist — invisible in the working set
  // (it has no tg id) but live in the topic index, in recall_memory and in the
  // profile cards distilled from the store.
  it('folds a mis-heard spelling into the person it belongs to', () => {
    const people = [
      { tgUserId: 7, name: 'Швед' },
      { tgUserId: 8, name: 'Иван' },
    ];
    expect(resolveSubject('Швец', people)).toEqual({ tgUserId: 7, subject: 'Швед' });
  });

  it('folds onto a known person who has no tg id, canonicalising the spelling', () => {
    const people = [{ tgUserId: null, name: 'Шведов' }];
    expect(resolveSubject('Шведав', people)).toEqual({
      tgUserId: null,
      subject: 'Шведов',
    });
  });

  it('refuses to guess when two known people are equally near', () => {
    // Both share the «шве» stem and sit one edit from «Швец» — we cannot tell which
    // was meant, so the fact stays unkeyed rather than being pinned on the wrong one.
    const people = [
      { tgUserId: 1, name: 'Швед' },
      { tgUserId: 2, name: 'Швет' },
    ];
    expect(resolveSubject('Швец', people)).toEqual({
      tgUserId: null,
      subject: 'Швец',
    });
  });

  it('never invents a person: an unfamiliar name stays its own subject', () => {
    // Facts about non-participants («Гоша», Аня's brother) must keep working.
    const people = [{ tgUserId: 1, name: 'Маша Иванова' }];
    expect(resolveSubject('Гоша', people)).toEqual({ tgUserId: null, subject: 'Гоша' });
  });

  it('prefers the identified duplicate when a person is both sender and stored', () => {
    const people = [
      { tgUserId: null, name: 'Швед' },
      { tgUserId: 7, name: 'Швед' },
    ];
    // Deduped by name — otherwise the fuzzy step would call it ambiguous and give up.
    expect(resolveSubject('Швец', people)).toEqual({ tgUserId: 7, subject: 'Швед' });
  });
});
