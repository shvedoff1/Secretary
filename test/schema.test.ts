import { describe, it, expect } from 'vitest';
import { RecordExpenseZ, toParsedExpense } from '../src/llm/schema.js';

describe('RecordExpenseZ', () => {
  it('accepts a well-formed expense and normalizes currency', () => {
    const parsed = RecordExpenseZ.parse({
      title: 'Такси',
      amountMinor: 50000,
      currency: 'eur',
      payerHints: [],
      profiteerHints: ['я', 'Коля'],
      splits: null,
      confidence: 0.9,
      notes: null,
    });
    const exp = toParsedExpense(parsed);
    expect(exp.currency).toBe('EUR');
    expect(exp.amountMinor).toBe(50000);
    expect(exp.profiteerHints).toEqual(['я', 'Коля']);
  });

  it('rejects non-integer amounts', () => {
    const res = RecordExpenseZ.safeParse({
      title: 'x',
      amountMinor: 12.5,
      currency: 'EUR',
      payerHints: [],
      profiteerHints: [],
      splits: null,
      confidence: 0.5,
      notes: null,
    });
    expect(res.success).toBe(false);
  });
});
