import type { Context } from 'grammy';
import { getUser } from '../../db/repos/users.repo.js';
import { t } from '../../i18n/index.js';

export async function cmdStart(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  const user = uid ? getUser(uid) : undefined;
  const status = user?.status ?? t('common.notRequested');
  const ready = user?.status === 'approved';
  await ctx.reply(
    [
      t('start.greeting'),
      t('start.intro'),
      '',
      t('start.status', { status }),
      ready ? t('start.ready') : t('start.needRequest'),
    ].join('\n'),
  );
}
