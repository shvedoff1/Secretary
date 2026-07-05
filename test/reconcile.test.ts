import { describe, it, expect } from 'vitest';
import { parseReconcileJson, withExpenseSweep } from '../src/llm/reconcile.js';
import type { MemoryItem } from '../src/db/repos/memoryItem.repo.js';

function item(over: Partial<MemoryItem>): MemoryItem {
  return {
    id: 1,
    chatId: 1,
    scope: 'chat',
    tgUserId: null,
    subject: '',
    content: 'факт',
    importance: 3,
    reinforce: 0,
    source: 'passive',
    createdAt: 0,
    lastSeen: 0,
    ...over,
  };
}

describe('parseReconcileJson', () => {
  it('parses a clean plan object', () => {
    const out = parseReconcileJson(
      '{"deletes":[{"id":12,"reason":"устарело"}],"edits":[{"id":7,"content":"итог","reason":"слил"}]}',
    );
    expect(out.deletes).toEqual([{ id: 12, reason: 'устарело' }]);
    expect(out.edits).toEqual([{ id: 7, content: 'итог', reason: 'слил' }]);
  });

  it('salvages an object wrapped in prose / fences', () => {
    const out = parseReconcileJson(
      'Вот:\n```json\n{"deletes":[{"id":3,"reason":"дубль"}],"edits":[]}\n```',
    );
    expect(out.deletes).toEqual([{ id: 3, reason: 'дубль' }]);
    expect(out.edits).toEqual([]);
  });

  it('returns an empty plan on malformed JSON', () => {
    expect(parseReconcileJson('not json')).toEqual({ deletes: [], edits: [] });
    expect(parseReconcileJson('{ broken')).toEqual({ deletes: [], edits: [] });
  });

  it('skips bad entries (missing/invalid id, blank edit content)', () => {
    const out = parseReconcileJson(
      '{"deletes":[{"id":5,"reason":"ok"},{"id":0},{"reason":"no id"}],' +
        '"edits":[{"id":9,"content":"good"},{"id":2,"content":"   "}]}',
    );
    expect(out.deletes).toEqual([{ id: 5, reason: 'ok' }]);
    expect(out.edits).toEqual([{ id: 9, content: 'good', reason: '' }]);
  });

  it('drops a delete that also appears as an edit (edit wins)', () => {
    const out = parseReconcileJson(
      '{"deletes":[{"id":7,"reason":"x"}],"edits":[{"id":7,"content":"kept","reason":"merge"}]}',
    );
    expect(out.deletes).toEqual([]); // #7 is edited, so the stray delete is dropped
    expect(out.edits).toEqual([{ id: 7, content: 'kept', reason: 'merge' }]);
  });
});

describe('withExpenseSweep', () => {
  const items: MemoryItem[] = [
    item({ id: 1, content: 'едут на Бали ради серфинга' }),
    item({ id: 2, content: 'Расход на кофе 260 тыс, платил Антон, делится пополам' }),
    item({ id: 3, content: 'такси 500, заплатил я, делим на всех' }),
    item({ id: 4, content: 'Курс обмена сегодня: 17700 рупий за доллар' }), // not an expense
  ];

  it('deterministically marks every recorded-expense line for deletion', () => {
    const out = withExpenseSweep({ deletes: [], edits: [] }, items);
    expect(out.deletes.map((d) => d.id).sort()).toEqual([2, 3]);
    expect(out.deletes.every((d) => /Splid/.test(d.reason))).toBe(true);
  });

  it('does not double-add an expense the model already flagged, nor touch edited ids', () => {
    const plan = { deletes: [{ id: 2, reason: 'модель' }], edits: [{ id: 3, content: 'x', reason: 'merge' }] };
    const out = withExpenseSweep(plan, items);
    // #2 already deleted (kept once), #3 is edited (skipped) → no new expense deletes.
    expect(out.deletes.map((d) => d.id).sort()).toEqual([2]);
    expect(out.edits).toEqual(plan.edits);
  });

  it('is idempotent on a store with no expenses', () => {
    const clean = [item({ id: 1, content: 'любит серф' })];
    expect(withExpenseSweep({ deletes: [], edits: [] }, clean).deletes).toEqual([]);
  });
});
