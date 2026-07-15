import type { Context } from 'grammy';
import { logger } from '../../logger.js';
import {
  isAdmin,
  listUsers,
  upsertStatus,
  type UserRow,
} from '../../db/repos/users.repo.js';
import { getChatMode } from '../../db/repos/chatSettings.repo.js';
import { replyLong } from '../../util/telegramText.js';

/** Admin-only, DM-only (the whitelist holds other people's ids/names). */
async function ensureAdminDM(ctx: Context): Promise<boolean> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    if (ctx.chat?.type === 'private') await ctx.reply('Команда только для администратора.');
    return false;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Вайтлист работает только в личке со мной.');
    return false;
  }
  return true;
}

const STATUS_ICON: Record<UserRow['status'], string> = {
  approved: '✅',
  pending: '⏳',
  denied: '❌',
};

function describe(u: UserRow): string {
  const name = u.display_name ?? '(без имени)';
  const username = u.username ? ` @${u.username}` : '';
  const role = u.role === 'admin' ? ' · админ' : '';
  // A private chat's id equals the user's id, so the user's DM mode is theirs.
  const mode = getChatMode(u.tg_user_id) === 'tutor' ? ' · 🎓 репетитор' : '';
  return `${STATUS_ICON[u.status]} ${name}${username} — id ${u.tg_user_id}${role}${mode}`;
}

/** `/whitelist` — who may talk to the bot, and how to change that. */
export async function cmdWhitelist(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const users = listUsers();
  if (users.length === 0) {
    await ctx.reply(
      'Вайтлист пуст. Добавить: /allow <telegram_id> [имя]. ' +
        'Либо пусть человек отправит боту /request — придёт кнопка одобрения.',
    );
    return;
  }
  await replyLong(
    ctx,
    [
      `Вайтлист (${users.length}):`,
      ...users.map(describe),
      '',
      'Добавить: /allow <id> [имя] · Закрыть доступ: /deny <id>',
      'Режим ученика для лички: /mode <id> tutor',
    ].join('\n'),
  );
}

/**
 * `/allow <telegram_id> [имя]` — whitelist someone by id, no /request needed.
 * The optional name is just a label for the admin's list.
 */
export async function cmdAllow(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const m = /^(\d+)\s*([\s\S]*)$/.exec(arg);
  const id = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    await ctx.reply(
      'Использование: /allow <telegram_id> [имя]\n' +
        'id можно узнать у человека через @userinfobot, либо пусть он отправит мне /request.',
    );
    return;
  }
  const name = m![2]!.trim() || null;
  upsertStatus(id, 'approved', ctx.from!.id, name);
  await ctx.reply(`✅ ${name ?? id} (id ${id}) в вайтлисте — доступ открыт. Список: /whitelist`);
  // Best-effort heads-up; fails silently when the user hasn't started the bot yet.
  try {
    await ctx.api.sendMessage(id, '✅ Доступ открыт! Наберите /help.');
  } catch (err) {
    logger.debug({ err, id }, 'could not notify newly allowed user');
  }
}
