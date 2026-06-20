import { describe, it, expect } from 'vitest';
import { minorToMajor, majorToMinor, formatMoney } from '../src/util/money.js';

describe('money', () => {
  it('converts EUR (2 decimals)', () => {
    expect(minorToMajor(1250, 'EUR')).toBe(12.5);
    expect(majorToMinor(12.5, 'EUR')).toBe(1250);
    expect(formatMoney(1250, 'EUR')).toBe('12.50 EUR');
  });

  it('handles zero-decimal currencies (JPY)', () => {
    expect(minorToMajor(500, 'JPY')).toBe(500);
    expect(majorToMinor(500, 'JPY')).toBe(500);
    expect(formatMoney(500, 'JPY')).toBe('500 JPY');
  });

  it('rounds correctly', () => {
    expect(majorToMinor(0.1 + 0.2, 'EUR')).toBe(30);
  });
});
