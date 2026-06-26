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

/** A half-open instant range [fromMs, toMs) in unix milliseconds. */
export interface DateRange {
  fromMs: number;
  toMs: number;
}

/** One member's net standing in a group (positive = owed money, negative = owes). */
export interface MemberBalance {
  memberId: string;
  netMinor: Minor;
}

/** A suggested transfer to settle up: `fromId` should pay `toId` `amountMinor`. */
export interface Settlement {
  fromId: string;
  toId: string;
  amountMinor: Minor;
}

/**
 * Who-owes-whom snapshot for a group, in a single currency (the group's default;
 * the provider converts multi-currency entries when it computes this).
 */
export interface BalanceSummary {
  currency: string;
  balances: MemberBalance[];
  settlements: Settlement[];
}

/**
 * A provider-agnostic view of an already-recorded expense, read back from the
 * provider (e.g. for reports). Money is in integer minor units, like everything
 * else in the domain; the provider boundary converts from its own format.
 */
export interface ExpenseRecord {
  /** Provider-specific stable id (Splid: Entry.GlobalId). */
  id: string;
  title?: string;
  /** Human category label as the provider stores it (Splid: category.originalName). */
  category?: string;
  /** Stable category key/type for matching (Splid: category.type, e.g. "restaurants"). */
  categoryKey?: string;
  currency: string; // ISO 4217
  /** Total amount of the expense (minor units). */
  amountMinor: Minor;
  /** How much each payer fronted, keyed by member id (minor units). */
  payerAmounts: Record<string, Minor>;
  /** When the expense occurred (purchased-on date if known, else created-at). */
  occurredMs: number;
}
