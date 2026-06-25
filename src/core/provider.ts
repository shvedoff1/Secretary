import type {
  DateRange,
  ExpenseDraft,
  ExpenseRecord,
  Member,
  SubmitResult,
} from './types.js';

/** A resolved handle to a provider's target (e.g. a Splid group). */
export interface ProviderConnection {
  groupId: string;
}

/**
 * The extensibility seam. Each integration (Splid, Splitwise, Sheets, ...)
 * implements this. Core and bot code depend only on this interface.
 */
export interface ExpenseProvider {
  readonly name: string;
  /** Resolve a credential (e.g. an invite code) into a connection. */
  connect(credential: string): Promise<ProviderConnection>;
  listMembers(conn: ProviderConnection): Promise<Member[]>;
  submitExpense(
    conn: ProviderConnection,
    draft: ExpenseDraft,
  ): Promise<SubmitResult>;
  /**
   * Read back expenses that occurred within `range` (real spending only —
   * settlement/payment entries and deleted entries are excluded). Used by
   * reporting features; reading from the provider keeps a single source of
   * truth (expenses added directly in the provider's own app are included).
   */
  listExpenses(
    conn: ProviderConnection,
    range: DateRange,
  ): Promise<ExpenseRecord[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ProviderError';
  }
}
