import { describe, it, expect } from 'vitest';
import { RecordExpenseZ, toParsedExpense } from '../src/llm/schema.js';

function parse(over: Record<string, unknown> = {}) {
  return RecordExpenseZ.parse({
    title: 'Такси',
    amount: 500,
    currency: 'eur',
    payerHints: [],
    profiteerHints: ['я', 'Коля'],
    splits: null,
    confidence: 0.9,
    notes: null,
    ...over,
  });
}

describe('RecordExpenseZ + toParsedExpense', () => {
  it('normalizes currency and keeps the hints', () => {
    const exp = toParsedExpense(parse());
    expect(exp.currency).toBe('EUR');
    expect(exp.profiteerHints).toEqual(['я', 'Коля']);
  });

  it('converts a two-decimal currency from natural to minor units', () => {
    const exp = toParsedExpense(parse({ amount: 12.5, currency: 'EUR' }));
    expect(exp.amountMinor).toBe(1250);
  });

  it('does NOT multiply a zero-decimal currency (IDR) by 100', () => {
    // Regression: "10000 IDR" must stay 10000, not become 1_000_000.
    const exp = toParsedExpense(parse({ amount: 10000, currency: 'IDR' }));
    expect(exp.amountMinor).toBe(10000);
  });

  it('converts split amounts with the same currency scale', () => {
    const exp = toParsedExpense(
      parse({
        amount: 50,
        currency: 'EUR',
        splits: [
          { memberHint: 'Коля', amount: 20, share: null },
          { memberHint: 'Маша', amount: 30, share: null },
        ],
      }),
    );
    expect(exp.splits).toEqual([
      { memberHint: 'Коля', amountMinor: 2000, share: null },
      { memberHint: 'Маша', amountMinor: 3000, share: null },
    ]);
  });

  it('keeps a share-based split as-is (no amount)', () => {
    const exp = toParsedExpense(
      parse({ splits: [{ memberHint: 'Коля', amount: null, share: 0.5 }] }),
    );
    expect(exp.splits).toEqual([{ memberHint: 'Коля', amountMinor: null, share: 0.5 }]);
  });

  it('accepts fractional amounts now (no longer integer-only) and rejects negatives', () => {
    expect(RecordExpenseZ.safeParse({ ...parse(), amount: 12.5 }).success).toBe(true);
    expect(
      RecordExpenseZ.safeParse({
        title: 'x',
        amount: -1,
        currency: 'EUR',
        payerHints: [],
        profiteerHints: [],
        splits: null,
        confidence: 0.5,
        notes: null,
      }).success,
    ).toBe(false);
  });
});
