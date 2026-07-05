import { describe, it, expect } from 'vitest';
import { minorToMajor, majorToMinor, formatMoney, looksLikeExpense } from '../src/util/money.js';

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

describe('looksLikeExpense', () => {
  it('flags recorded expenses (a number plus a spend verb)', () => {
    expect(looksLikeExpense('Расход на кофе: 260 тыс. рупий. Платил Anton. Делится пополам')).toBe(
      true,
    );
    expect(looksLikeExpense('такси 500, заплатил я, делим на всех')).toBe(true);
    expect(looksLikeExpense('dinner 60 split with Anna')).toBe(true);
    expect(looksLikeExpense('paid 100k for the boat')).toBe(true);
  });

  it('keeps plain facts that merely mention money or numbers', () => {
    // FX rate — a number and currency words, but no spend intent.
    expect(looksLikeExpense('Курс обмена сегодня: 17700 рупий за доллар')).toBe(false);
    // A phone number.
    expect(looksLikeExpense('Номер телефона: +62 878-1000-2500')).toBe(false);
    // A durable preference with no amount.
    expect(looksLikeExpense('Антоха любитель приложения граб и оверпрайснутых вещей')).toBe(false);
    // A spend word but no number is not enough.
    expect(looksLikeExpense('он вечно всё оплачивает картой')).toBe(false);
  });
});
