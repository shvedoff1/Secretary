import { describe, it, expect } from 'vitest';
import {
  minorToMajor,
  majorToMinor,
  formatMoney,
  looksLikeExpense,
  isValidCurrencyCode,
} from '../src/util/money.js';

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

describe('isValidCurrencyCode', () => {
  it('accepts real ISO 4217 codes, case-insensitively', () => {
    for (const c of ['EUR', 'usd', 'Rub', 'VND', 'IDR', 'JPY']) {
      expect(isValidCurrencyCode(c)).toBe(true);
    }
  });

  it('rejects invented codes and wrong shapes', () => {
    // A made-up code used to be stored verbatim and reach Splid as an unknown currency.
    expect(isValidCurrencyCode('ZZZ')).toBe(false);
    expect(isValidCurrencyCode('ABC')).toBe(false);
    expect(isValidCurrencyCode('EU')).toBe(false);
    expect(isValidCurrencyCode('EURO')).toBe(false);
    expect(isValidCurrencyCode('123')).toBe(false);
    expect(isValidCurrencyCode('')).toBe(false);
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

  it('does not treat a long, multi-line config blob as an expense', () => {
    // A hand-entered memory blob that merely CONTAINS an expense-formatting rule (plus
    // numbers elsewhere) must not be swept as an expense — this was nuking chat config.
    const blob = [
      '- это чат про поездку на Бали ради серфинга',
      'адрес хаты: Gg. Jero, Tibubeneng, Bali 80361',
      '- При внесении траты в Splid бот должен расписывать: кто платил, на кого делится',
      '- с вероятностью 30% добавляй слово "иншала"',
    ].join('\n');
    expect(looksLikeExpense(blob)).toBe(false);
    // A single very long line that merely mentions spending is also not one expense.
    expect(looksLikeExpense('x'.repeat(300) + ' платил 5 делится')).toBe(false);
  });

  it('flags a completed purchase with an explicit price', () => {
    // The shape that used to leak into memory and then stall record_expense with
    // «у меня уже есть запись — это то же самое или новая покупка?».
    expect(looksLikeExpense('Иван купил билеты в метро за 300')).toBe(true);
    expect(looksLikeExpense('покупка продуктов за 1200, на всех')).toBe(true);
    expect(looksLikeExpense('bought ferry tickets for 300k')).toBe(true);
  });

  it('keeps purchases without a price (plans, requests, life events)', () => {
    // A year is not a price — a durable life-event fact stays rememberable.
    expect(looksLikeExpense('купил дом в 2020')).toBe(false);
    // A shopping request is not a spend record.
    expect(looksLikeExpense('купи 2 литра молока')).toBe(false);
    // A plan with a price but no completed purchase verb.
    expect(looksLikeExpense('хочет машину примерно на 2 млн')).toBe(false);
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
