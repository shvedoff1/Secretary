import type { Context } from 'grammy';
import { getProvider } from '../../core/registry.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';
import { listMappings } from '../../db/repos/memberMap.repo.js';
import { t } from '../../i18n/index.js';

export async function cmdMembers(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const cfg = getChatConfig(ctx.chat.id);
  if (!cfg?.provider_group_id) {
    await ctx.reply(t('members.noGroup'));
    return;
  }

  let members;
  try {
    members = await getProvider(cfg.provider_name).listMembers({
      groupId: cfg.provider_group_id,
    });
  } catch {
    await ctx.reply(t('members.loadFailed'));
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
    return link
      ? t('members.memberLinked', { label, link })
      : t('members.memberUnlinked', { label });
  });

  await ctx.reply(
    [
      t('members.header', { count: members.length }),
      ...lines,
      '',
      t('members.linkHint'),
    ].join('\n'),
  );
}
