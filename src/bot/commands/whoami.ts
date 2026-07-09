import type { Context } from 'grammy';
import { getUser } from '../../db/repos/users.repo.js';
import { getMapping } from '../../db/repos/memberMap.repo.js';
import { t } from '../../i18n/index.js';

export async function cmdWhoami(ctx: Context): Promise<void> {
  const u = ctx.from;
  if (!u || !ctx.chat) return;
  const user = getUser(u.id);
  const mapping = getMapping(ctx.chat.id, u.id);
  await ctx.reply(
    [
      t('whoami.id', { id: u.id }),
      t('whoami.username', { username: u.username ? '@' + u.username : '—' }),
      t('whoami.role', { role: user?.role ?? 'user' }),
      t('whoami.status', { status: user?.status ?? t('common.notRequested') }),
      t('whoami.mapping', { mapping: mapping ? mapping.member_name : '—' }),
    ].join('\n'),
  );
}
