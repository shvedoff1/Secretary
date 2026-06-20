import type { ExpenseDraft } from '../../core/types.js';
import { minorToMajor } from '../../util/money.js';

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
