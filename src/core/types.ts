// Provider-agnostic domain types. Nothing here may import a concrete provider
// (e.g. splid-js) — that dependency lives only under src/providers/.

/** Integer minor units (e.g. cents). Never use floats for money. */
export type Minor = number;

export interface Member {
  /** Provider-specific stable id. For Splid this is Person.GlobalId. */
  id: string;
  name: string;
  initials?: string;
}

/**
 * One participant's share of an expense.
 * - `amount` set: this member is responsible for an absolute amount (minor units).
 * - `share` set: this member's relative weight (0..1, shares sum to 1).
 * - neither set: equal split among all entries.
 * Within a single list, use one style consistently.
 */
export interface Split {
  memberId: string;
  amount?: Minor;
  share?: number;
}

/**
 * The model's structured extraction of an expense. Names are kept verbatim as
 * the user wrote them ("hints"); resolution to member ids happens in code.
 */
export interface ParsedExpense {
  title: string;
  amountMinor: Minor;
  currency: string; // ISO 4217
  payerHints: string[]; // [] => sender
  profiteerHints: string[]; // [] or ["all"] => everyone
  /** Uneven split, keyed by member hint; null => equal split. */
  splits: ParsedSplit[] | null;
  confidence: number; // 0..1
  notes?: string | null;
}

export interface ParsedSplit {
  memberHint: string;
  amountMinor: Minor | null;
  share: number | null;
}

/** A fully-resolved expense ready to submit to a provider. */
export interface ExpenseDraft {
  title: string;
  amountMinor: Minor;
  currency: string;
  payers: Split[];
  profiteers: Split[];
  /** Hints we could not map to a member. Non-empty => submit is blocked. */
  unresolved: string[];
  /** Diagnostics carried from parsing, surfaced in the preview. */
  confidence: number;
  notes?: string | null;
}

export interface SubmitResult {
  externalId: string;
}
