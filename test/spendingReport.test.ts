import { describe, it, expect } from 'vitest';
import type { BalanceSummary, ExpenseRecord } from '../src/core/types.js';
import {
  aggregate,
  formatBalances,
  formatSpendingReport,
  resolveSpending,
} from '../src/spending/report.js';

function rec(over: Partial<ExpenseRecord>): ExpenseRecord {
  return {
    id: 'r',
    title: 'thing',
    currency: 'EUR',
    amountMinor: 1000,
    payerAmounts: { A: 1000 },
    occurredMs: 0,
    ...over,
  };
}

describe('aggregate', () => {
  it('totals by currency, sums per payer, and picks the top expense', () => {
    const agg = aggregate([
      rec({ id: '1', title: 'Taxi', amountMinor: 2000, payerAmounts: { A: 2000 } }),
      rec({ id: '2', title: 'Lunch', amountMinor: 5000, payerAmounts: { A: 3000, B: 2000 } }),
      rec({ id: '3', title: 'Sushi', amountMinor: 4000, currency: 'JPY', payerAmounts: { B: 4000 } }),
    ]);
    expect(agg.count).toBe(3);
    expect(agg.totals).toEqual({ EUR: 7000, JPY: 4000 });
    expect(agg.payers.find((p) => p.memberId === 'A')?.totals).toEqual({ EUR: 5000 });
    expect(agg.payers.find((p) => p.memberId === 'B')?.totals).toEqual({ EUR: 2000, JPY: 4000 });
    expect(agg.top).toEqual({ title: 'Lunch', amountMinor: 5000, currency: 'EUR' });
  });

  it('orders payers by amount fronted (single currency)', () => {
    const agg = aggregate([
      rec({ id: '1', amountMinor: 2000, payerAmounts: { A: 2000 } }),
      rec({ id: '2', amountMinor: 5000, payerAmounts: { A: 3000, B: 2000 } }),
    ]);
    expect(agg.payers.map((p) => p.memberId)).toEqual(['A', 'B']);
  });

  it('handles an empty period', () => {
    const agg = aggregate([]);
    expect(agg.count).toBe(0);
    expect(agg.payers).toEqual([]);
    expect(agg.top).toBeUndefined();
  });
});

describe('formatSpendingReport', () => {
  const names = new Map([
    ['A', 'Аня'],
    ['B', 'Боря'],
  ]);

  it('formats totals, payers and the top expense', () => {
    const agg = aggregate([
      rec({ id: '1', title: 'Такси', amountMinor: 2000, payerAmounts: { A: 2000 } }),
      rec({ id: '2', title: 'Ужин', amountMinor: 5000, payerAmounts: { A: 3000, B: 2000 } }),
    ]);
    const text = formatSpendingReport(agg, names, { periodLabel: '24 июня' });
    expect(text).toContain('Траты за 24 июня');
    expect(text).toContain('Всего: 70.00 EUR (2 траты)');
    expect(text).toContain('• Аня — 50.00 EUR');
    expect(text).toContain('• Боря — 20.00 EUR');
    expect(text).toContain('Крупнейшая: «Ужин» — 50.00 EUR');
  });

  it('falls back to a placeholder name for unknown payers', () => {
    const text = formatSpendingReport(aggregate([rec({ payerAmounts: { Z: 1000 } })]), names, {
      periodLabel: '24 июня',
    });
    expect(text).toContain('• кто-то — 10.00 EUR');
  });

  it('returns a "nothing spent" note for an empty period', () => {
    const text = formatSpendingReport(aggregate([]), names, { periodLabel: '24 июня' });
    expect(text).toContain('никто ничего не потратил');
    expect(text).toContain('24 июня');
  });
});

describe('formatBalances', () => {
  const names = new Map([
    ['A', 'Аня'],
    ['B', 'Боря'],
  ]);

  it('lists who owes whom', () => {
    const summary: BalanceSummary = {
      currency: 'EUR',
      balances: [
        { memberId: 'A', netMinor: 2500 },
        { memberId: 'B', netMinor: -2500 },
      ],
      settlements: [{ fromId: 'B', toId: 'A', amountMinor: 2500 }],
    };
    const text = formatBalances(summary, names);
    expect(text).toContain('Кто кому должен');
    expect(text).toContain('• Боря → Аня: 25.00 EUR');
  });

  it('says everyone is settled when there are no transfers', () => {
    const summary: BalanceSummary = { currency: 'EUR', balances: [], settlements: [] };
    expect(formatBalances(summary, names)).toContain('Все в расчёте');
  });
});

describe('resolveSpending', () => {
  const tz = 'Europe/Berlin';
  const now = Date.parse('2026-06-25T08:00:00Z'); // 10:00 Berlin on the 25th

  it('defaults to yesterday when no dates are given', () => {
    const r = resolveSpending({ fromDate: null, toDate: null }, tz, now);
    expect(r.fromDate).toBe('2026-06-24');
    expect(r.toDate).toBe('2026-06-24');
    expect(r.label).toContain('24');
    expect(new Date(r.range.fromMs).toISOString()).toBe('2026-06-23T22:00:00.000Z');
    expect(new Date(r.range.toMs).toISOString()).toBe('2026-06-24T22:00:00.000Z');
  });

  it('treats a single date as just that day', () => {
    const r = resolveSpending({ fromDate: '2026-06-20', toDate: null }, tz, now);
    expect(r.fromDate).toBe('2026-06-20');
    expect(r.toDate).toBe('2026-06-20');
    expect(r.label).not.toContain('—');
  });

  it('spans an inclusive multi-day range and labels it', () => {
    const r = resolveSpending({ fromDate: '2026-06-22', toDate: '2026-06-24' }, tz, now);
    expect(new Date(r.range.fromMs).toISOString()).toBe('2026-06-21T22:00:00.000Z');
    expect(new Date(r.range.toMs).toISOString()).toBe('2026-06-24T22:00:00.000Z');
    expect(r.label).toContain('—');
  });

  it('normalises a reversed range', () => {
    const r = resolveSpending({ fromDate: '2026-06-24', toDate: '2026-06-22' }, tz, now);
    expect(r.fromDate).toBe('2026-06-22');
    expect(r.toDate).toBe('2026-06-24');
  });
});
