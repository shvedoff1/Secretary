import type { Context } from 'grammy';
import type { Member } from '../../core/types.js';
import { getProvider } from '../../core/registry.js';
import { ProviderError } from '../../core/provider.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';
import {
  getPending,
  claimForConfirm,
  setStatus,
} from '../../db/repos/pending.repo.js';
import { recordAudit } from '../../db/repos/audit.repo.js';
import { previewKeyboard } from '../keyboards.js';
import { renderConfirmed, nameMapFromMembers } from './preview.js';
import { clearEditTarget } from '../editTargets.js';
import { takeQuip, clearQuip } from '../quipCache.js';
import { logger } from '../../logger.js';
import { t } from '../../i18n/index.js';

/** Handles callback queries with the `e:` prefix (expense preview actions). */
export async function handleExpenseCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const parts = data.split(':');
  const action = parts[1];
  const pendingId = parts[2];
  if (!action || !pendingId) {
    await ctx.answerCallbackQuery();
    return;
  }

  switch (action) {
    case 'no':
      return cancel(ctx, pendingId);
    case 'ed':
      await ctx.answerCallbackQuery({
        text: t('confirm.editHint'),
        show_alert: false,
      });
      return;
    case 'ok':
    case 'rt':
      return submit(ctx, pendingId, action === 'rt');
    default:
      await ctx.answerCallbackQuery();
  }
}

async function cancel(ctx: Context, pendingId: string): Promise<void> {
  const pending = getPending(pendingId);
  if (pending) setStatus(pendingId, 'cancelled');
  clearQuip(pendingId); // drop the pre-generated joke for an abandoned preview
  await ctx.answerCallbackQuery({ text: t('confirm.cancelledToast') });
  await safeEdit(ctx, t('confirm.cancelled'));
  if (ctx.chat) clearEditTarget(ctx.chat.id, ctx.callbackQuery!.message!.message_id);
}

async function submit(
  ctx: Context,
  pendingId: string,
  isRetry: boolean,
): Promise<void> {
  const pending = isRetry
    ? getPending(pendingId)
    : claimForConfirm(pendingId);

  if (!pending) {
    await ctx.answerCallbackQuery({ text: t('confirm.alreadyProcessed') });
    return;
  }
  if (isRetry && pending.status !== 'confirmed') {
    await ctx.answerCallbackQuery({ text: t('confirm.nothingToRetry') });
    return;
  }
  if (pending.draft.unresolved.length > 0) {
    await ctx.answerCallbackQuery({
      text: t('confirm.fixUnresolvedFirst'),
      show_alert: true,
    });
    if (!isRetry) setStatus(pendingId, 'awaiting'); // allow re-tap after edit
    return;
  }

  const cfg = getChatConfig(pending.chatId);
  if (!cfg?.provider_group_id) {
    await ctx.answerCallbackQuery({ text: t('confirm.chatNotConfigured'), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: t('confirm.recording') });

  try {
    const provider = getProvider(cfg.provider_name);
    const result = await provider.submitExpense(
      { groupId: cfg.provider_group_id },
      pending.draft,
    );
    recordAudit({
      chatId: pending.chatId,
      tgUserId: pending.tgUserId,
      pendingId,
      providerName: cfg.provider_name,
      externalId: result.externalId,
      draft: pending.draft,
      outcome: 'submitted',
    });
    // Re-render from the draft so the confirmation keeps the details (payer,
    // split, notes) instead of collapsing to a single line. Names need members;
    // a failed lookup just falls back to "(?)" without losing the rest.
    let members: Member[] = [];
    try {
      members = await provider.listMembers({ groupId: cfg.provider_group_id });
    } catch (err) {
      logger.warn({ err, pendingId }, 'could not load members for confirmation');
    }
    // Append the comic riff that was pre-generated in the background when the
    // preview was shown — read it from the cache (no OpenAI call here, so the
    // confirmation renders instantly). Display-only and added after the write, so
    // it can never affect the recorded data; absent → confirmation shown without it.
    const quip = takeQuip(pendingId) ?? null;
    await safeEdit(
      ctx,
      renderConfirmed(pending.draft, nameMapFromMembers(members), cfg.provider_name, quip),
    );
    if (ctx.chat) clearEditTarget(ctx.chat.id, ctx.callbackQuery!.message!.message_id);
  } catch (err) {
    const retriable = err instanceof ProviderError && err.retriable;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, pendingId }, 'expense submit failed');
    recordAudit({
      chatId: pending.chatId,
      tgUserId: pending.tgUserId,
      pendingId,
      providerName: cfg.provider_name,
      externalId: null,
      draft: pending.draft,
      outcome: 'failed',
      error: msg,
    });
    await safeEdit(
      ctx,
      t('confirm.submitFailed', { msg }) + (retriable ? t('confirm.canRetry') : ''),
      retriable ? previewKeyboard(pendingId, true) : undefined,
    );
  }
}

async function safeEdit(
  ctx: Context,
  text: string,
  keyboard?: ReturnType<typeof previewKeyboard>,
): Promise<void> {
  try {
    await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : {});
  } catch {
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  }
}
