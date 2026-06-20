import type { ExpenseDraft, Member, SubmitResult } from './types.js';

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
