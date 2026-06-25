import { SplidClient, type SplidJs } from 'splid-js';
import {
  ProviderError,
  type ExpenseProvider,
  type ProviderConnection,
} from '../../core/provider.js';
import type {
  DateRange,
  ExpenseDraft,
  ExpenseRecord,
  Member,
  SubmitResult,
} from '../../core/types.js';
import { fromSplidEntry, toSplidExpense } from './map.js';

/**
 * Splid integration via the unofficial `splid-js` client. This is the ONLY file
 * that imports splid-js; if Splid's protocol changes, swap this file out.
 *
 * Auth model: a group invite code resolves to a groupId (no account needed).
 */
export class SplidProvider implements ExpenseProvider {
  readonly name = 'splid';
  private readonly client = new SplidClient();

  async connect(credential: string): Promise<ProviderConnection> {
    const code = credential.replace(/\s+/g, '');
    try {
      const res = await this.client.group.getByInviteCode(code);
      const groupId = res?.result?.objectId;
      if (!groupId) {
        throw new ProviderError('Splid returned no group for this code', false);
      }
      return { groupId };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        'Could not connect to the Splid group (check the invite code)',
        isRetriable(err),
        err,
      );
    }
  }

  async listMembers(conn: ProviderConnection): Promise<Member[]> {
    try {
      const people = await this.client.person.getAllByGroup(conn.groupId);
      return people
        .filter((p: SplidJs.Person) => !p.isDeleted)
        .map((p: SplidJs.Person) => ({
          id: p.GlobalId,
          name: p.name,
          initials: p.initials,
        }));
    } catch (err) {
      throw new ProviderError(
        'Could not load members from Splid',
        isRetriable(err),
        err,
      );
    }
  }

  async listExpenses(
    conn: ProviderConnection,
    range: DateRange,
  ): Promise<ExpenseRecord[]> {
    try {
      const entries = await this.client.entry.getAllByGroup(conn.groupId);
      // Splid can return duplicate copies of the same entry; dedupe by id.
      const unique = SplidClient.dedupeByGlobalId(entries);
      const records: ExpenseRecord[] = [];
      for (const entry of unique) {
        const rec = fromSplidEntry(entry);
        if (!rec) continue; // deleted or a payment/settlement
        if (rec.occurredMs >= range.fromMs && rec.occurredMs < range.toMs) {
          records.push(rec);
        }
      }
      return records;
    } catch (err) {
      throw new ProviderError(
        'Could not load expenses from Splid',
        isRetriable(err),
        err,
      );
    }
  }

  async submitExpense(
    conn: ProviderConnection,
    draft: ExpenseDraft,
  ): Promise<SubmitResult> {
    if (draft.unresolved.length > 0) {
      throw new ProviderError(
        `Cannot submit: unresolved participants: ${draft.unresolved.join(', ')}`,
        false,
      );
    }
    const { options, item } = toSplidExpense(conn.groupId, draft);
    try {
      const res = await this.client.entry.expense.create(options, item);
      const externalId = res?.[0]?.success?.objectId ?? 'unknown';
      return { externalId };
    } catch (err) {
      throw new ProviderError(
        'Splid rejected the expense',
        isRetriable(err),
        err,
      );
    }
  }
}

function isRetriable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err);
  // Network / transient signals are worth a retry; validation/4xx are not.
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econn') ||
    msg.includes('fetch failed') ||
    msg.includes('rate limit') ||
    /\b5\d\d\b/.test(msg)
  );
}
