import { describe, it, expect } from 'vitest';
import { toSplidExpense } from '../src/providers/splid/map.js';
import type { ExpenseDraft } from '../src/core/types.js';

const base: ExpenseDraft = {
  title: 'Taxi',
  amountMinor: 1000,
  currency: 'EUR',
  payers: [{ memberId: 'A' }],
  profiteers: [{ memberId: 'A' }, { memberId: 'B' }],
  unresolved: [],
  confidence: 0.9,
  notes: null,
};

describe('toSplidExpense', () => {
  it('maps an equal split to bare id arrays in major units', () => {
    const { options, item } = toSplidExpense('G', base);
    expect(options.groupId).toBe('G');
    expect(options.currencyCode).toBe('EUR');
    expect(options.payers).toEqual(['A']);
    expect(item.amount).toBe(10);
    expect(item.profiteers).toEqual(['A', 'B']);
  });

  it('maps uneven profiteer shares', () => {
    const draft: ExpenseDraft = {
      ...base,
      profiteers: [
        { memberId: 'A', share: 0.25 },
        { memberId: 'B', share: 0.75 },
      ],
    };
    const { item } = toSplidExpense('G', draft);
    expect(item.profiteers).toEqual([
      { id: 'A', share: 0.25 },
      { id: 'B', share: 0.75 },
    ]);
  });

  it('maps uneven payer amounts to major units', () => {
    const draft: ExpenseDraft = {
      ...base,
      payers: [
        { memberId: 'A', amount: 600 },
        { memberId: 'B', amount: 400 },
      ],
    };
    const { options } = toSplidExpense('G', draft);
    expect(options.payers).toEqual([
      { id: 'A', amount: 6 },
      { id: 'B', amount: 4 },
    ]);
  });
});
