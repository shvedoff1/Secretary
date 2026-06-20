// All money is stored and passed around as integer minor units (e.g. cents).
// Splid's client works in major units (e.g. euros as a float), so conversion
// happens only at the provider boundary.

// Currencies with 0 decimal places (no minor unit). Extend as needed.
const ZERO_DECIMAL = new Set([
  'JPY',
  'KRW',
  'VND',
  'IDR', // commonly used without sub-units in practice
  'CLP',
  'ISK',
  'HUF',
]);

export function decimalsFor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function minorToMajor(amountMinor: number, currency: string): number {
  const d = decimalsFor(currency);
  return amountMinor / 10 ** d;
}

export function majorToMinor(amountMajor: number, currency: string): number {
  const d = decimalsFor(currency);
  return Math.round(amountMajor * 10 ** d);
}

export function formatMoney(amountMinor: number, currency: string): string {
  const d = decimalsFor(currency);
  const major = minorToMajor(amountMinor, currency);
  return `${major.toFixed(d)} ${currency.toUpperCase()}`;
}
