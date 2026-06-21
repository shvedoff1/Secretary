import type { Context } from 'grammy';
import { listTasks, deleteTask } from '../../db/repos/scheduledTask.repo.js';
import { formatInTimezone } from '../../util/schedule.js';

export async function cmdTasks(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const tasks = listTasks(ctx.chat.id);
  if (tasks.length === 0) {
    await ctx.reply(
      'Активных напоминаний нет. Напиши, например: «каждое утро в 8 ищи прогноз волн и кидай сюда».',
    );
    return;
  }
  const lines = tasks.map((t) => {
    const kind = t.once ? '🔔' : '🔁';
    const when = formatInTimezone(t.nextRunAt, t.timezone);
    return `${kind} #${t.id} «${t.title}» — следующий запуск ${when} (${t.timezone})`;
  });
  await ctx.reply(
    ['⏰ Напоминания и задачи:', ...lines, '', 'Отменить: /canceltask <id>'].join('\n'),
  );
}

export async function cmdCancelTask(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const id = Number(arg);
  if (!arg || !Number.isInteger(id)) {
    await ctx.reply('Использование: /canceltask <id> (id смотри в /tasks)');
    return;
  }
  const ok = deleteTask(id, ctx.chat.id);
  await ctx.reply(ok ? `🗑 Задача #${id} удалена.` : `Не нашёл задачу #${id} в этом чате.`);
}
