import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isApproved, requestAccess } from '../../db/repos/users.repo.js';
import { approvalKeyboard } from '../keyboards.js';
import { t } from '../../i18n/index.js';

export async function cmdRequest(ctx: Context): Promise<void> {
  const u = ctx.from;
  if (!u) return;
  if (isApproved(u.id)) {
    await ctx.reply(t('request.alreadyHave'));
    return;
  }

  const displayName =
    [u.first_name, u.last_name].filter(Boolean).join(' ') || null;
  requestAccess(u.id, u.username ?? null, displayName);
  await ctx.reply(t('request.sent'));

  const { ADMIN_TELEGRAM_ID } = loadConfig();
  try {
    await ctx.api.sendMessage(
      ADMIN_TELEGRAM_ID,
      t('request.adminNotice', {
        name: displayName ?? '—',
        username: u.username ? '@' + u.username : '',
        id: u.id,
      }),
      { reply_markup: approvalKeyboard(u.id) },
    );
  } catch (err) {
    logger.warn({ err }, 'could not notify admin about access request');
  }
}
