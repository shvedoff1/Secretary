import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isApproved, requestAccess } from '../../db/repos/users.repo.js';
import { approvalKeyboard } from '../keyboards.js';

export async function cmdRequest(ctx: Context): Promise<void> {
  const u = ctx.from;
  if (!u) return;
  if (isApproved(u.id)) {
    await ctx.reply('У вас уже есть доступ.');
    return;
  }

  const displayName =
    [u.first_name, u.last_name].filter(Boolean).join(' ') || null;
  requestAccess(u.id, u.username ?? null, displayName);
  await ctx.reply('Запрос отправлен администратору. Ожидайте одобрения.');

  const { ADMIN_TELEGRAM_ID } = loadConfig();
  try {
    await ctx.api.sendMessage(
      ADMIN_TELEGRAM_ID,
      `Запрос доступа:\n${displayName ?? '—'} ${u.username ? '@' + u.username : ''}\nid: ${u.id}`,
      { reply_markup: approvalKeyboard(u.id) },
    );
  } catch (err) {
    logger.warn({ err }, 'could not notify admin about access request');
  }
}
