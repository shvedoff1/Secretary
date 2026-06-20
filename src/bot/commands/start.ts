import type { Context } from 'grammy';
import { getUser } from '../../db/repos/users.repo.js';

export async function cmdStart(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  const user = uid ? getUser(uid) : undefined;
  const status = user?.status ?? 'не запрошен';
  const ready = user?.status === 'approved';
  await ctx.reply(
    [
      'Привет! Я Secretary 🤝',
      'Записываю общие траты в Splid и помогаю в чате (вопросы, заметки).',
      '',
      `Ваш статус доступа: ${status}.`,
      ready
        ? 'Готов к работе — наберите /help.'
        : 'Отправьте /request, чтобы запросить доступ у администратора.',
    ].join('\n'),
  );
}
