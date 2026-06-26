import type { SplidJs } from 'splid-js';
import type { ExpenseDraft, ExpenseRecord } from '../../core/types.js';
import { majorToMinor, minorToMajor } from '../../util/money.js';

type SplidPayers = string[] | { id: string; amount: number }[];
type SplidProfiteers = string[] | { id: string; share: number }[];

export interface SplidExpenseArgs {
  options: {
    groupId: string;
    title?: string;
    payers: SplidPayers;
    currencyCode?: string;
  };
  item: {
    amount: number;
    profiteers: SplidProfiteers;
  };
}

/**
 * Translate a provider-agnostic ExpenseDraft into the argument shape that
 * splid-js's `entry.expense.create(options, item)` expects.
 *
 * - Money: splid-js works in MAJOR units (floats); we store minor units.
 * - Equal split: pass a bare array of member ids.
 * - Uneven payers: `{ id, amount }` (major units).
 * - Uneven profiteers: `{ id, share }` (relative weights, ~sum to 1).
 */
export function toSplidExpense(
  groupId: string,
  draft: ExpenseDraft,
): SplidExpenseArgs {
  const { currency } = draft;

  const payersHaveAmounts = draft.payers.some((p) => p.amount != null);
  const payers: SplidPayers = payersHaveAmounts
    ? draft.payers.map((p) => ({
        id: p.memberId,
        amount: minorToMajor(p.amount ?? 0, currency),
      }))
    : draft.payers.map((p) => p.memberId);

  const profiteersHaveShares = draft.profiteers.some(
    (p) => p.share != null || p.amount != null,
  );
  const profiteers: SplidProfiteers = profiteersHaveShares
    ? draft.profiteers.map((p) => ({
        id: p.memberId,
        // Prefer an explicit relative share; otherwise derive one from the
        // absolute amount against the total.
        share:
          p.share ??
          (draft.amountMinor > 0 ? (p.amount ?? 0) / draft.amountMinor : 0),
      }))
    : draft.profiteers.map((p) => p.memberId);

  return {
    options: {
      groupId,
      title: draft.title,
      payers,
      currencyCode: currency,
    },
    item: {
      amount: minorToMajor(draft.amountMinor, currency),
      profiteers,
    },
  };
}

/** Read the ISO timestamp out of a Splid date-ish field, if present. */
function isoOf(d: SplidJs.Entry['date'] | undefined): string | undefined {
  if (d && '__type' in d && d.__type === 'Date') return d.iso;
  return undefined;
}

/** Pull the category name + type out of a Splid entry's category field, if set. */
function categoryOf(
  c: SplidJs.Entry['category'] | undefined,
): { name?: string; key?: string } {
  if (c && 'type' in c) return { name: c.originalName, key: c.type };
  return {};
}

/**
 * Translate a Splid `Entry` read back from the API into a provider-agnostic
 * {@link ExpenseRecord}, or `null` when it isn't a real expense we want to count
 * (deleted entries, and payment/settlement entries which move money between
 * members rather than recording spending).
 *
 * - Amounts: Splid stores MAJOR units (floats); we convert to minor units.
 * - Payers: `primaryPayer` fronts the total minus whatever `secondaryPayers`
 *   covered; each secondary payer fronted their listed amount.
 * - Occurred-at: the "Purchased On" date if set, otherwise the created date.
 */
export function fromSplidEntry(entry: SplidJs.Entry): ExpenseRecord | null {
  if (entry.isDeleted || entry.isPayment) return null;

  const currency = entry.currencyCode;
  const items: SplidJs.EntryItem[] = entry.items ?? [];
  const totalMajor = items.reduce(
    (sum: number, item) => sum + (item.AM ?? 0),
    0,
  );

  const secondary: Record<string, number> = entry.secondaryPayers ?? {};
  const secondaryMajor = Object.values(secondary).reduce(
    (sum: number, v) => sum + (v ?? 0),
    0,
  );

  const payerAmounts: Record<string, number> = {};
  for (const [id, amountMajor] of Object.entries(secondary)) {
    payerAmounts[id] = (payerAmounts[id] ?? 0) + majorToMinor(amountMajor, currency);
  }
  // The primary payer covers the remainder. Clamp at zero in case of rounding
  // quirks where secondary amounts slightly exceed the total.
  const primaryMajor = Math.max(0, totalMajor - secondaryMajor);
  payerAmounts[entry.primaryPayer] =
    (payerAmounts[entry.primaryPayer] ?? 0) + majorToMinor(primaryMajor, currency);

  const iso = isoOf(entry.date) ?? entry.createdAt;
  const occurredMs = iso ? Date.parse(iso) : NaN;

  const { name: category, key: categoryKey } = categoryOf(entry.category);

  return {
    id: entry.GlobalId,
    title: entry.title,
    category,
    categoryKey,
    currency,
    amountMinor: majorToMinor(totalMajor, currency),
    payerAmounts,
    occurredMs: Number.isNaN(occurredMs) ? 0 : occurredMs,
  };
}
