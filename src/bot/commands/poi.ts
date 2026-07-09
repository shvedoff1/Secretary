import type { Context } from 'grammy';
import { listPois, deletePoi } from '../../db/repos/poi.repo.js';
import { renderPoiList } from '../../util/poi.js';
import { sendRichMarkdown } from '../../util/richMessage.js';
import { t } from '../../i18n/index.js';

export async function cmdPoi(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const pois = listPois(ctx.chat.id);
  if (pois.length === 0) {
    await ctx.reply(t('poi.empty'));
    return;
  }
  const md = renderPoiList(pois);
  await sendRichMarkdown(ctx.api, ctx.chat.id, md, { disableLinkPreview: true });
}

export async function cmdDelPoi(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const id = Number(arg);
  if (!arg || !Number.isInteger(id)) {
    await ctx.reply(t('poi.del.usage'));
    return;
  }
  const ok = deletePoi(id, ctx.chat.id);
  await ctx.reply(ok ? t('poi.del.deleted', { id }) : t('poi.del.notFound', { id }));
}
