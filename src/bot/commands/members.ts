import type { Context } from 'grammy';
import { getProvider } from '../../core/registry.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';
import { listMappings } from '../../db/repos/memberMap.repo.js';

export async function cmdMembers(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const cfg = getChatConfig(ctx.chat.id);
  if (!cfg?.provider_group_id) {
    await ctx.reply('Группа не подключена. Используйте /group <код>.');
    return;
  }

  let members;
  try {
    members = await getProvider(cfg.provider_name).listMembers({
      groupId: cfg.provider_group_id,
    });
  } catch {
    await ctx.reply('Не удалось загрузить участников из Splid.');
    return;
  }

  const mappings = listMappings(ctx.chat.id);
  const linkedBy = new Map<string, string>(); // memberId → "tg name"
  for (const m of mappings) {
    linkedBy.set(m.provider_member_id, `tg:${m.tg_user_id}`);
  }

  const lines = members.map((m) => {
    const label = m.initials ? `${m.name} (${m.initials})` : m.name;
    const link = linkedBy.get(m.id);
    return `• ${label}${link ? ` ↔ ${link}` : ' — не привязан'}`;
  });

  await ctx.reply(
    [`Участники Splid (${members.length}):`, ...lines, '', 'Привязать: /link <имя|инициалы> (себя) или в ответ на сообщение участника.'].join('\n'),
  );
}
