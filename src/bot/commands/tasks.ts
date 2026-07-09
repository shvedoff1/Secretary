import type { Context } from 'grammy';
import { listTasks, deleteTask, setTaskHumor } from '../../db/repos/scheduledTask.repo.js';
import { formatInTimezone } from '../../util/schedule.js';
import { t } from '../../i18n/index.js';

export async function cmdTasks(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const tasks = listTasks(ctx.chat.id);
  if (tasks.length === 0) {
    await ctx.reply(t('tasks.none'));
    return;
  }
  const lines = tasks.map((task) => {
    const kind = task.once ? '🔔' : '🔁';
    const humor = task.humor ? ' 😂' : '';
    const when = formatInTimezone(task.nextRunAt, task.timezone);
    return t('tasks.line', {
      kind,
      humor,
      id: task.id,
      title: task.title,
      when,
      timezone: task.timezone,
    });
  });
  await ctx.reply(
    [
      t('tasks.list.header'),
      ...lines,
      '',
      t('tasks.list.cancelHint'),
      t('tasks.list.humorHint'),
    ].join('\n'),
  );
}

export async function cmdTaskHumor(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const [idArg, modeArg] = arg.split(/\s+/);
  const id = Number(idArg);
  const mode = (modeArg ?? '').toLowerCase();
  const on = ['on', 'вкл', 'да', 'true', '1'].includes(mode);
  const off = ['off', 'выкл', 'нет', 'false', '0'].includes(mode);
  if (!idArg || !Number.isInteger(id) || (!on && !off)) {
    await ctx.reply(t('tasks.humor.usage'));
    return;
  }
  const ok = setTaskHumor(id, ctx.chat.id, on);
  if (!ok) {
    await ctx.reply(t('tasks.humor.notFound', { id }));
    return;
  }
  await ctx.reply(on ? t('tasks.humor.on', { id }) : t('tasks.humor.off', { id }));
}

export async function cmdCancelTask(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const id = Number(arg);
  if (!arg || !Number.isInteger(id)) {
    await ctx.reply(t('tasks.cancel.usage'));
    return;
  }
  const ok = deleteTask(id, ctx.chat.id);
  await ctx.reply(ok ? t('tasks.cancel.deleted', { id }) : t('tasks.cancel.notFound', { id }));
}
