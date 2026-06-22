import type { Context } from 'grammy';
import type { ExpenseDraft, Member, Split } from '../../core/types.js';
import { formatMoney } from '../../util/money.js';
import { createPending, type PendingSource } from '../../db/repos/pending.repo.js';
import { previewKeyboard } from '../keyboards.js';
import { setEditTarget } from '../editTargets.js';

export function renderDraft(
  draft: ExpenseDraft,
  nameOf: (id: string) => string,
  roster?: string[],
): string {
  const lines: string[] = [];
  lines.push(`🧾 ${draft.title}`);
  lines.push(`💰 ${formatMoney(draft.amountMinor, draft.currency)}`);

  const payerNames = draft.payers.map((p) => nameOf(p.memberId)).join(', ');
  lines.push(`👤 Платил: ${payerNames || '—'}`);
  lines.push(`👥 Делим на: ${describeProfiteers(draft.profiteers, nameOf)}`);

  if (draft.unresolved.length > 0) {
    lines.push(`⚠️ Не распознаны: ${draft.unresolved.join(', ')}`);
    if (roster && roster.length > 0) {
      lines.push(`Участники группы: ${roster.join(', ')}`);
    }
    lines.push('✏️ Ответь на это сообщение и уточни, кто это (напр. «это Миша»).');
  }
  if (draft.notes) lines.push(`📝 ${draft.notes}`);
  if (draft.confidence < 0.6) {
    lines.push(`🤔 Не очень уверен (${Math.round(draft.confidence * 100)}%) — проверьте.`);
  }
  return lines.join('\n');
}

/**
 * Final message shown after the expense is recorded. Unlike the one-line
 * confirmation it keeps the meaningful details (payer, split, notes) so they
 * aren't lost when the preview message is edited in place. Rendered from the
 * draft (not the preview text) so it's correct even on the retry path.
 */
export function renderConfirmed(
  draft: ExpenseDraft,
  nameOf: (id: string) => string,
  providerName: string,
): string {
  const lines = [`✅ Записано в ${providerName}`];
  lines.push(`🧾 ${draft.title}`);
  lines.push(`💰 ${formatMoney(draft.amountMinor, draft.currency)}`);
  const payerNames = draft.payers.map((p) => nameOf(p.memberId)).join(', ');
  lines.push(`👤 Платил: ${payerNames || '—'}`);
  lines.push(`👥 Делим на: ${describeProfiteers(draft.profiteers, nameOf)}`);
  if (draft.notes) lines.push(`📝 ${draft.notes}`);
  return lines.join('\n');
}

function describeProfiteers(
  profiteers: Split[],
  nameOf: (id: string) => string,
): string {
  if (profiteers.length === 0) return '—';
  const uneven = profiteers.some((p) => p.amount != null || p.share != null);
  if (!uneven) return profiteers.map((p) => nameOf(p.memberId)).join(', ');
  return profiteers
    .map((p) => {
      const name = nameOf(p.memberId);
      if (p.amount != null) return `${name} (фикс.)`;
      if (p.share != null) return `${name} (${Math.round(p.share * 100)}%)`;
      return name;
    })
    .join(', ');
}

export function nameMapFromMembers(members: Member[]): (id: string) => string {
  const map = new Map(members.map((m) => [m.id, m.name]));
  return (id: string) => map.get(id) ?? '(?)';
}

export async function presentDraft(
  ctx: Context,
  args: {
    chatId: number;
    tgUserId: number;
    draft: ExpenseDraft;
    source: PendingSource;
    members: Member[];
  },
): Promise<void> {
  const pending = createPending({
    chatId: args.chatId,
    tgUserId: args.tgUserId,
    draft: args.draft,
    source: args.source,
  });

  const text = renderDraft(
    args.draft,
    nameMapFromMembers(args.members),
    args.members.map((m) => m.name),
  );
  const sent = await ctx.reply(text, {
    reply_markup: previewKeyboard(pending.id),
  });
  // Allow rewording by replying to this preview message.
  setEditTarget(args.chatId, sent.message_id, pending.id);
}
