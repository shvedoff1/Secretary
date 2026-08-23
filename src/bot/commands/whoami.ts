import type { Context } from 'grammy';
import { getUser } from '../../db/repos/users.repo.js';
import { getMapping } from '../../db/repos/memberMap.repo.js';
import { listManagedChats } from '../../db/repos/chatAdmin.repo.js';
import { isSupremeAdmin } from '../permissions.js';
import { escapeHtml } from '../../util/telegramHtml.js';

export async function cmdWhoami(ctx: Context): Promise<void> {
  const u = ctx.from;
  if (!u || !ctx.chat) return;
  const user = getUser(u.id);
  const mapping = getMapping(ctx.chat.id, u.id);

  const managed = listManagedChats(u.id);
  const role = isSupremeAdmin(u.id)
    ? 'верховный админ'
    : managed.length > 0
      ? `админ чатов: ${managed.length} (список — /chats в личке)`
      : 'участник';

  // Ids are what the admin commands take — render them tap-to-copy, since for
  // groups there is no other built-in way to learn the chat id at all.
  await ctx.reply(
    [
      `id: <code>${u.id}</code>`,
      `username: ${u.username ? '@' + u.username : '—'}`,
      `роль: ${role}`,
      `статус: ${user?.status ?? 'не запрошен'}`,
      `чат: <code>${ctx.chat.id}</code>`,
      `привязка в этом чате: ${mapping ? escapeHtml(mapping.member_name) : '—'}`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}
