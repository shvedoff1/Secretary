import { describe, it, expect } from 'vitest';
import { buildDraft } from '../src/core/expenseService.js';
import type { Member, ParsedExpense } from '../src/core/types.js';

const members: Member[] = [
  { id: 'a', name: 'Alex', initials: 'AL' },
  { id: 'k', name: 'Коля', initials: 'KO' },
  { id: 'm', name: 'Маша', initials: 'MA' },
];

function parsed(over: Partial<ParsedExpense>): ParsedExpense {
  return {
    title: 'Taxi',
    amountMinor: 50000,
    currency: 'EUR',
    payerHints: [],
    profiteerHints: [],
    splits: null,
    confidence: 0.9,
    notes: null,
    ...over,
  };
}

describe('buildDraft', () => {
  it('defaults payer to sender and profiteers to everyone', () => {
    const d = buildDraft({
      parsed: parsed({}),
      members,
      senderMemberId: 'a',
      defaultCurrency: 'EUR',
    });
    expect(d.payers).toEqual([{ memberId: 'a' }]);
    expect(d.profiteers.map((p) => p.memberId).sort()).toEqual(['a', 'k', 'm']);
    expect(d.unresolved).toEqual([]);
  });

  it('resolves named profiteers including "me"', () => {
    const d = buildDraft({
      parsed: parsed({ profiteerHints: ['я', 'Коля'] }),
      members,
      senderMemberId: 'a',
      defaultCurrency: 'EUR',
    });
    expect(d.profiteers.map((p) => p.memberId).sort()).toEqual(['a', 'k']);
  });

  it('flags unresolved names', () => {
    const d = buildDraft({
      parsed: parsed({ profiteerHints: ['Коля', 'Петя'] }),
      members,
      senderMemberId: 'a',
      defaultCurrency: 'EUR',
    });
    expect(d.unresolved).toContain('Петя');
  });

  it('treats "все" as everyone', () => {
    const d = buildDraft({
      parsed: parsed({ profiteerHints: ['все'] }),
      members,
      senderMemberId: 'a',
      defaultCurrency: 'EUR',
    });
    expect(d.profiteers).toHaveLength(3);
  });

  it('marks sender unresolved when not linked and no payer hint', () => {
    const d = buildDraft({
      parsed: parsed({}),
      members,
      senderMemberId: null,
      defaultCurrency: 'EUR',
    });
    expect(d.unresolved.length).toBeGreaterThan(0);
    expect(d.payers).toEqual([]);
  });

  it('carries uneven splits by member hint', () => {
    const d = buildDraft({
      parsed: parsed({
        splits: [
          { memberHint: 'Коля', amountMinor: 20000, share: null },
          { memberHint: 'Маша', amountMinor: 30000, share: null },
        ],
      }),
      members,
      senderMemberId: 'a',
      defaultCurrency: 'EUR',
    });
    expect(d.profiteers).toEqual([
      { memberId: 'k', amount: 20000 },
      { memberId: 'm', amount: 30000 },
    ]);
  });
});
