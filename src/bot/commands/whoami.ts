import type { Context } from 'grammy';
import { getUser } from '../../db/repos/users.repo.js';
import { getMapping } from '../../db/repos/memberMap.repo.js';

export async function cmdWhoami(ctx: Context): Promise<void> {
  const u = ctx.from;
  if (!u || !ctx.chat) return;
  const user = getUser(u.id);
  const mapping = getMapping(ctx.chat.id, u.id);
  await ctx.reply(
    [
      `id: ${u.id}`,
      `username: ${u.username ? '@' + u.username : '—'}`,
      `роль: ${user?.role ?? 'user'}`,
      `статус: ${user?.status ?? 'не запрошен'}`,
      `привязка в этом чате: ${mapping ? mapping.member_name : '—'}`,
    ].join('\n'),
  );
}
