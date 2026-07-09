import type { Context } from 'grammy';
import { logger } from '../../logger.js';
import {
  getUser,
  isAdmin,
  setStatus,
  type UserStatus,
} from '../../db/repos/users.repo.js';
import { t } from '../../i18n/index.js';

async function decide(
  ctx: Context,
  status: UserStatus,
  arg: string | undefined,
): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply(t('approve.adminOnly'));
    return;
  }
  const id = Number((arg ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) {
    await ctx.reply(t('approve.usage'));
    return;
  }
  setStatus(id, status, ctx.from.id);
  await ctx.reply(t('approve.done', { id, status }));
  await notifyUser(ctx, id, status);
}

export async function cmdApprove(ctx: Context): Promise<void> {
  await decide(ctx, 'approved', ctx.match as string | undefined);
}

export async function cmdDeny(ctx: Context): Promise<void> {
  await decide(ctx, 'denied', ctx.match as string | undefined);
}

/** Callback handler for the inline Approve/Deny buttons (prefix `u:`). */
export async function handleUserCallback(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: t('approve.adminOnlyShort') });
    return;
  }
  const parts = (ctx.callbackQuery?.data ?? '').split(':');
  const action = parts[1];
  const id = Number(parts[2]);
  if (!action || !Number.isInteger(id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const status: UserStatus = action === 'ap' ? 'approved' : 'denied';
  setStatus(id, status, ctx.from.id);
  await ctx.answerCallbackQuery({
    text: status === 'approved' ? t('approve.cbApproved') : t('approve.cbDenied'),
  });
  const user = getUser(id);
  const label = user?.display_name ?? id;
  try {
    await ctx.editMessageText(
      status === 'approved'
        ? t('approve.editApproved', { label, id })
        : t('approve.editDenied', { label, id }),
    );
  } catch {
    /* message may be too old to edit */
  }
  await notifyUser(ctx, id, status);
}

async function notifyUser(
  ctx: Context,
  id: number,
  status: UserStatus,
): Promise<void> {
  const text =
    status === 'approved' ? t('approve.granted') : t('approve.denied');
  try {
    await ctx.api.sendMessage(id, text);
  } catch (err) {
    logger.warn({ err, id }, 'could not notify user about decision');
  }
}
