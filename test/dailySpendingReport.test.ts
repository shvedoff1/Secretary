import { describe, it, expect } from 'vitest';
import type { ExpenseRecord } from '../src/core/types.js';
import {
  aggregate,
  decideDue,
  formatDailyReport,
  yesterdayWindow,
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
    // A fronted 5000 EUR, B fronted 2000 EUR + 4000 JPY.
    const a = agg.payers.find((p) => p.memberId === 'A');
    const b = agg.payers.find((p) => p.memberId === 'B');
    expect(a?.totals).toEqual({ EUR: 5000 });
    expect(b?.totals).toEqual({ EUR: 2000, JPY: 4000 });
    expect(agg.top).toEqual({ title: 'Lunch', amountMinor: 5000, currency: 'EUR' });
  });

  it('orders payers by amount fronted (single currency)', () => {
    const agg = aggregate([
      rec({ id: '1', amountMinor: 2000, payerAmounts: { A: 2000 } }),
      rec({ id: '2', amountMinor: 5000, payerAmounts: { A: 3000, B: 2000 } }),
    ]);
    // A fronted 5000, B fronted 2000 — A leads.
    expect(agg.payers.map((p) => p.memberId)).toEqual(['A', 'B']);
  });

  it('handles an empty day', () => {
    const agg = aggregate([]);
    expect(agg.count).toBe(0);
    expect(agg.payers).toEqual([]);
    expect(agg.top).toBeUndefined();
  });
});

describe('formatDailyReport', () => {
  const names = new Map([
    ['A', 'Аня'],
    ['B', 'Боря'],
  ]);

  it('formats totals, payers and the top expense', () => {
    const agg = aggregate([
      rec({ id: '1', title: 'Такси', amountMinor: 2000, payerAmounts: { A: 2000 } }),
      rec({ id: '2', title: 'Ужин', amountMinor: 5000, payerAmounts: { A: 3000, B: 2000 } }),
    ]);
    const text = formatDailyReport(agg, names, { humanDate: '24 июня' });
    expect(text).toContain('Траты за 24 июня');
    expect(text).toContain('Всего: 70.00 EUR (2 траты)');
    expect(text).toContain('• Аня — 50.00 EUR');
    expect(text).toContain('• Боря — 20.00 EUR');
    expect(text).toContain('Крупнейшая: «Ужин» — 50.00 EUR');
  });

  it('falls back to a placeholder name for unknown payers', () => {
    const agg = aggregate([rec({ payerAmounts: { Z: 1000 } })]);
    const text = formatDailyReport(agg, names, { humanDate: '24 июня' });
    expect(text).toContain('• кто-то — 10.00 EUR');
  });

  it('returns a "nothing spent" note for an empty day', () => {
    const text = formatDailyReport(aggregate([]), names, { humanDate: '24 июня' });
    expect(text).toContain('никто ничего не потратил');
    expect(text).toContain('24 июня');
  });
});

describe('decideDue', () => {
  const tz = 'Europe/Berlin';
  // 2026-06-25 08:00 Berlin == 06:00Z
  const at = (iso: string) => Date.parse(iso);

  it('does not fire before the target time', () => {
    const d = decideDue(at('2026-06-25T06:00:00Z'), tz, {
      hour: 9,
      minute: 0,
      lastDate: null,
    });
    expect(d.send).toBe(false);
    expect(d.window.reportDate).toBe('2026-06-24');
  });

  it('fires once the target time passes and the day is unsent', () => {
    const d = decideDue(at('2026-06-25T07:30:00Z'), tz, {
      hour: 9, // 09:00 Berlin == 07:00Z
      minute: 0,
      lastDate: null,
    });
    expect(d.send).toBe(true);
    expect(d.window.reportDate).toBe('2026-06-24');
  });

  it('does not fire again once that report date was posted', () => {
    const d = decideDue(at('2026-06-25T10:00:00Z'), tz, {
      hour: 9,
      minute: 0,
      lastDate: '2026-06-24',
    });
    expect(d.send).toBe(false);
  });
});

describe('yesterdayWindow', () => {
  it('reports the previous local day', () => {
    const w = yesterdayWindow(Date.parse('2026-06-25T08:00:00Z'), 'Europe/Berlin');
    expect(w.reportDate).toBe('2026-06-24');
    expect(new Date(w.fromMs).toISOString()).toBe('2026-06-23T22:00:00.000Z');
    expect(new Date(w.toMs).toISOString()).toBe('2026-06-24T22:00:00.000Z');
  });
});
