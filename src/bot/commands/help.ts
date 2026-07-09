import type { Context } from 'grammy';
import { isAdmin } from '../../db/repos/users.repo.js';
import { t } from '../../i18n/index.js';

export async function cmdHelp(ctx: Context): Promise<void> {
  const adminSection =
    ctx.from && isAdmin(ctx.from.id)
      ? [
          '',
          t('help.adminTitle'),
          t('help.adminChats'),
          t('help.adminSetgroup'),
          t('help.adminSetmemory'),
          t('help.adminSetlink'),
        ]
      : [];
  await ctx.reply(
    [
      t('help.canDo'),
      t('help.featExpenses'),
      t('help.featQuestions'),
      t('help.featReminders'),
      t('help.featPlaces'),
      '',
      t('help.commandsTitle'),
      t('help.cmdGroup'),
      t('help.cmdMembers'),
      t('help.cmdLink'),
      t('help.cmdMemory'),
      t('help.cmdRemember'),
      t('help.cmdForget'),
      t('help.cmdTasks'),
      t('help.cmdCanceltask'),
      t('help.cmdTaskhumor'),
      t('help.cmdPoi'),
      t('help.cmdDelpoi'),
      t('help.cmdStyle'),
      t('help.cmdSlang'),
      t('help.cmdTrata'),
      t('help.cmdWhoami'),
      t('help.cmdRequest'),
      ...adminSection,
    ].join('\n'),
  );
}
