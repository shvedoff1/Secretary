import { describe, it, expect } from 'vitest';
import { renderConfirmed } from '../src/bot/flows/preview.js';
import type { ExpenseDraft } from '../src/core/types.js';

const NAMES: Record<string, string> = { a: 'Аня', b: 'Боря' };
const nameOf = (id: string): string => NAMES[id] ?? '(?)';

function draft(over: Partial<ExpenseDraft> = {}): ExpenseDraft {
  return {
    title: 'Продукты',
    amountMinor: 292500,
    currency: 'IDR',
    payers: [{ memberId: 'a' }],
    profiteers: [{ memberId: 'a' }, { memberId: 'b' }],
    unresolved: [],
    confidence: 0.9,
    notes: null,
    ...over,
  };
}

describe('renderConfirmed', () => {
  it('keeps the recorded status plus the meaningful details', () => {
    const out = renderConfirmed(draft({ notes: 'пиво 150, чипсы 90' }), nameOf, 'splid');
    expect(out).toContain('✅ Записано в splid');
    expect(out).toContain('🧾 Продукты');
    expect(out).toContain('292500'); // amount via formatMoney
    expect(out).toContain('👤 Платил: Аня');
    expect(out).toContain('👥 Делим на: Аня, Боря');
    expect(out).toContain('📝 пиво 150, чипсы 90');
  });

  it('omits the notes line when there are no notes', () => {
    const out = renderConfirmed(draft({ notes: null }), nameOf, 'splid');
    expect(out).not.toContain('📝');
  });

  it('shows an uneven split (percentage / fixed)', () => {
    const share = renderConfirmed(
      draft({ profiteers: [{ memberId: 'a', share: 0.5 }, { memberId: 'b', share: 0.5 }] }),
      nameOf,
      'splid',
    );
    expect(share).toContain('Аня (50%)');

    const fixed = renderConfirmed(
      draft({ profiteers: [{ memberId: 'a', amount: 100000 }, { memberId: 'b', amount: 192500 }] }),
      nameOf,
      'splid',
    );
    expect(fixed).toContain('Аня (фикс.)');
  });

  it('does not throw on an unknown member', () => {
    const out = renderConfirmed(draft({ payers: [{ memberId: 'zzz' }] }), nameOf, 'splid');
    expect(out).toContain('👤 Платил: (?)');
  });

  it('appends the quip as a trailing block, separated from the data', () => {
    const out = renderConfirmed(draft(), nameOf, 'splid', '  ну ты и шопоголик 🤙  ');
    expect(out).toContain('✅ Записано в splid');
    // Trimmed and on its own block after a blank line.
    expect(out.endsWith('\n\nну ты и шопоголик 🤙')).toBe(true);
  });

  it('omits the quip block when it is null/empty', () => {
    expect(renderConfirmed(draft(), nameOf, 'splid', null)).not.toContain('\n\n');
    expect(renderConfirmed(draft(), nameOf, 'splid', '   ')).not.toContain('\n\n');
  });
});
