import { describe, it, expect } from 'vitest';
import type { SplidJs } from 'splid-js';
import { fromSplidEntry } from '../src/providers/splid/map.js';

function entry(over: Partial<SplidJs.Entry>): SplidJs.Entry {
  return {
    GlobalId: 'E1',
    UpdateInstallationID: 'u',
    UpdateID: 'u',
    primaryPayer: 'A',
    items: [{ AM: 30, P: { P: { A: 0.5, B: 0.5 }, PT: 0 } }],
    isDeleted: false,
    isPayment: false,
    currencyCode: 'EUR',
    createdAt: '2026-06-24T18:00:00.000Z',
    createdGlobally: { __type: 'Date', iso: '2026-06-24T18:00:00.000Z' },
    group: { __type: 'Pointer', className: '_User', objectId: 'G' },
    __type: 'Object',
    className: 'Entry',
    title: 'Dinner',
    ...over,
  } as SplidJs.Entry;
}

describe('fromSplidEntry', () => {
  it('maps a simple single-payer expense to minor units', () => {
    const rec = fromSplidEntry(entry({}));
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({
      id: 'E1',
      title: 'Dinner',
      currency: 'EUR',
      amountMinor: 3000,
      payerAmounts: { A: 3000 },
    });
  });

  it('splits payment between primary and secondary payers', () => {
    const rec = fromSplidEntry(
      entry({
        items: [{ AM: 100, P: { P: { A: 1 }, PT: 0 } }],
        primaryPayer: 'A',
        secondaryPayers: { B: 40 },
      }),
    );
    // B fronted 40, A covers the remaining 60.
    expect(rec?.payerAmounts).toEqual({ A: 6000, B: 4000 });
    expect(rec?.amountMinor).toBe(10000);
  });

  it('sums multiple items into the total', () => {
    const rec = fromSplidEntry(
      entry({
        items: [
          { AM: 10, P: { P: { A: 1 }, PT: 0 } },
          { AM: 5.5, P: { P: { A: 1 }, PT: 0 } },
        ],
      }),
    );
    expect(rec?.amountMinor).toBe(1550);
  });

  it('prefers the purchased-on date over createdAt', () => {
    const rec = fromSplidEntry(
      entry({ date: { __type: 'Date', iso: '2026-06-20T10:00:00.000Z' } }),
    );
    expect(rec?.occurredMs).toBe(Date.parse('2026-06-20T10:00:00.000Z'));
  });

  it('uses zero-decimal currencies without a fractional part', () => {
    const rec = fromSplidEntry(
      entry({ currencyCode: 'JPY', items: [{ AM: 3000, P: { P: { A: 1 }, PT: 0 } }] }),
    );
    expect(rec?.amountMinor).toBe(3000);
    expect(rec?.currency).toBe('JPY');
  });

  it('drops deleted entries', () => {
    expect(fromSplidEntry(entry({ isDeleted: true }))).toBeNull();
  });

  it('drops payment/settlement entries', () => {
    expect(fromSplidEntry(entry({ isPayment: true }))).toBeNull();
  });

  it('clamps the primary share when secondary payers exceed the total', () => {
    const rec = fromSplidEntry(
      entry({
        items: [{ AM: 10, P: { P: { A: 1 }, PT: 0 } }],
        secondaryPayers: { B: 12 },
      }),
    );
    // A would be negative; clamp to 0 rather than emit a negative payer share.
    expect(rec?.payerAmounts.A).toBe(0);
    expect(rec?.payerAmounts.B).toBe(1200);
  });
});
