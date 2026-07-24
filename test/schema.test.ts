import { describe, it, expect } from 'vitest';
import {
  RecordExpenseZ,
  RememberZ,
  EditMemoryZ,
  EditPingListZ,
  toParsedExpense,
} from '../src/llm/schema.js';

describe('RememberZ', () => {
  it('accepts a bare note (replaces optional)', () => {
    const r = RememberZ.safeParse({ note: 'любит серф' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.replaces).toBeUndefined();
  });

  it('accepts a note with facts to supersede', () => {
    const r = RememberZ.safeParse({ note: 'нас 4', replaces: ['Итого 5 человек'] });
    expect(r.success && r.data.replaces).toEqual(['Итого 5 человек']);
  });

  it('rejects an empty note', () => {
    expect(RememberZ.safeParse({ note: '' }).success).toBe(false);
  });
});

describe('EditMemoryZ', () => {
  it('requires both non-empty find and replace', () => {
    expect(EditMemoryZ.safeParse({ find: 'старое', replace: 'новое' }).success).toBe(true);
    expect(EditMemoryZ.safeParse({ find: 'старое' }).success).toBe(false);
    expect(EditMemoryZ.safeParse({ find: '', replace: 'x' }).success).toBe(false);
  });
});

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

describe('EditPingListZ', () => {
  it('accepts add/remove with several members and a null (default) list', () => {
    const add = EditPingListZ.safeParse({
      action: 'add',
      list: null,
      members: ['@vasya', '@petya'],
    });
    expect(add.success).toBe(true);
    const rm = EditPingListZ.safeParse({ action: 'remove', list: 'стак', members: ['@vasya'] });
    expect(rm.success).toBe(true);
  });

  it('accepts mute with structured windows and unmute without them', () => {
    const mute = EditPingListZ.safeParse({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [
        { days: [1, 2, 3, 4, 5], from: '00:00', to: '19:00' },
        { days: [7], from: '18:00', to: '21:00' },
      ],
      timezone: 'Europe/Moscow',
    });
    expect(mute.success).toBe(true);
    const unmute = EditPingListZ.safeParse({
      action: 'unmute',
      list: null,
      members: ['@vasya'],
      mute: null,
      timezone: null,
    });
    expect(unmute.success).toBe(true);
  });

  it('rejects malformed mute windows', () => {
    const badDay = EditPingListZ.safeParse({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [8], from: '00:00', to: '19:00' }],
    });
    expect(badDay.success).toBe(false);
    const badTime = EditPingListZ.safeParse({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [1], from: 'вечер', to: '19:00' }],
    });
    expect(badTime.success).toBe(false);
    const empty = EditPingListZ.safeParse({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [],
    });
    expect(empty.success).toBe(false);
  });

  it('accepts rename with a target handle', () => {
    const r = EditPingListZ.safeParse({
      action: 'rename',
      list: null,
      members: ['@ФилиппФилипп'],
      renameTo: '@philipp',
    });
    expect(r.success).toBe(true);
    expect(
      EditPingListZ.safeParse({
        action: 'rename',
        list: null,
        members: ['@x'],
        renameTo: '',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown actions, empty member lists and empty member strings', () => {
    expect(
      EditPingListZ.safeParse({ action: 'promote', list: null, members: ['@x'] }).success,
    ).toBe(false);
    expect(EditPingListZ.safeParse({ action: 'add', list: null, members: [] }).success).toBe(
      false,
    );
    expect(
      EditPingListZ.safeParse({ action: 'add', list: null, members: [''] }).success,
    ).toBe(false);
  });
});

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
