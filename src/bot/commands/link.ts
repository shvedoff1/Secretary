import type { Context } from 'grammy';
import { getProvider } from '../../core/registry.js';
import type { Member } from '../../core/types.js';
import { normalizeName } from '../../util/ids.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';
import { upsertMapping } from '../../db/repos/memberMap.repo.js';
import { isAdmin } from '../../db/repos/users.repo.js';
import { t } from '../../i18n/index.js';

function findMember(members: Member[], query: string): Member | undefined {
  const q = normalizeName(query);
  return (
    members.find((m) => normalizeName(m.name) === q) ??
    members.find((m) => m.initials && normalizeName(m.initials) === q) ??
    members.find((m) => normalizeName(m.name).includes(q))
  );
}

export async function cmdLink(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const cfg = getChatConfig(ctx.chat.id);
  if (!cfg?.provider_group_id) {
    await ctx.reply(t('link.noGroup'));
    return;
  }

  // Determine the target Telegram user (default: the caller).
  let target = ctx.from;
  const reply = ctx.message?.reply_to_message;
  if (reply?.from) target = reply.from;
  for (const e of ctx.message?.entities ?? []) {
    if (e.type === 'text_mention' && e.user) target = e.user;
  }

  if (target.id !== ctx.from.id && !isAdmin(ctx.from.id)) {
    await ctx.reply(t('link.adminOnly'));
    return;
  }

  const query = ((ctx.match as string | undefined) ?? '').trim();
  if (!query) {
    await ctx.reply(t('link.usage'));
    return;
  }

  let members: Member[];
  try {
    members = await getProvider(cfg.provider_name).listMembers({
      groupId: cfg.provider_group_id,
    });
  } catch {
    await ctx.reply(t('link.loadFailed'));
    return;
  }

  const member = findMember(members, query);
  if (!member) {
    await ctx.reply(t('link.notFound', { query }));
    return;
  }

  upsertMapping({
    chatId: ctx.chat.id,
    tgUserId: target.id,
    providerMemberId: member.id,
    memberName: member.name,
  });

  const who =
    target.id === ctx.from.id
      ? t('link.you')
      : [target.first_name, target.last_name].filter(Boolean).join(' ') ||
        `tg:${target.id}`;
  await ctx.reply(t('link.linked', { who, name: member.name }));
}
