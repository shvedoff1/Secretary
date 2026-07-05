import { describe, it, expect } from 'vitest';
import { parseReconcileJson } from '../src/llm/reconcile.js';

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
