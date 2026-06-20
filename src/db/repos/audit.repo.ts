import { getDb } from '../client.js';
import type { ExpenseDraft } from '../../core/types.js';

export function recordAudit(args: {
  chatId: number;
  tgUserId: number;
  pendingId: string | null;
  providerName: string;
  externalId: string | null;
  draft: ExpenseDraft;
  outcome: 'submitted' | 'failed';
  error?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log
         (chat_id, tg_user_id, pending_id, provider_name, external_id, draft_json, outcome, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)`,
    )
    .run(
      args.chatId,
      args.tgUserId,
      args.pendingId,
      args.providerName,
      args.externalId,
      JSON.stringify(args.draft),
      args.outcome,
      args.error ?? null,
    );
}
