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

// Expense-intent stems (RU) and words (EN). Paired with a number, they mark a line
// as a spend record — the kind of thing that belongs in the expense provider (Splid),
// not the chat's long-term memory. Kept deliberately conservative: it keys on an
// explicit spend verb, so an FX rate or a phone number (digits, but no spend intent)
// is NOT mistaken for an expense.
const EXPENSE_INTENT =
  /(расход|трат|заплат|оплат|платил|плачу|делит|делен|скинул|скидыв|должен|должн|split|paid|spent|owe|receipt)/iu;

/**
 * Heuristic: does this free-text note read like a recorded shared expense
 * ("Расход на кофе 260 тыс, платил Антон, делится…")? Requires BOTH a number and an
 * explicit spend-intent word, so plain facts that merely mention money survive.
 *
 * A recorded expense is a SHORT, SINGLE-LINE statement. A long or multi-line note that
 * merely mentions money — e.g. a chat's manually-entered config/persona blob that happens
 * to include a rule like "при внесении траты бот должен расписывать кто платил и делится"
 * — is NOT an expense, and treating it as one would wrongly purge hand-written memory.
 */
const MAX_EXPENSE_LEN = 220;

export function looksLikeExpense(text: string): boolean {
  if (text.includes('\n') || text.length > MAX_EXPENSE_LEN) return false;
  return /\d/.test(text) && EXPENSE_INTENT.test(text);
}
