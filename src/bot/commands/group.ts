import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { getProvider } from '../../core/registry.js';
import { ProviderError } from '../../core/provider.js';
import {
  getChatConfig,
  setProviderGroup,
  setChatTitle,
} from '../../db/repos/chatConfig.repo.js';
import { t } from '../../i18n/index.js';

export async function cmdGroup(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const code = ((ctx.match as string | undefined) ?? '').trim();
  if (!code) {
    await ctx.reply(t('group.usage'));
    return;
  }

  const provider = getProvider('splid');
  let groupId: string;
  try {
    const conn = await provider.connect(code);
    groupId = conn.groupId;
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : String(err);
    await ctx.reply(t('group.connectFailed', { msg }));
    return;
  }

  const { DEFAULT_CURRENCY } = loadConfig();
  setProviderGroup({
    chatId: ctx.chat.id,
    providerName: 'splid',
    credential: code,
    providerGroupId: groupId,
    defaultCurrency: getChatConfig(ctx.chat.id)?.default_currency ?? DEFAULT_CURRENCY,
    createdBy: ctx.from.id,
  });
  if (ctx.chat.title) setChatTitle(ctx.chat.id, ctx.chat.title);

  let count = 0;
  try {
    count = (await provider.listMembers({ groupId })).length;
  } catch {
    /* non-fatal */
  }
  await ctx.reply(t('group.connected', { count }));
}
