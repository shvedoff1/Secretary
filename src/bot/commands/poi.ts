import type { Context } from 'grammy';
import { listPois, deletePoi } from '../../db/repos/poi.repo.js';
import { renderPoiList } from '../../util/poi.js';
import { sendRichMarkdown } from '../../util/richMessage.js';

export async function cmdPoi(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const pois = listPois(ctx.chat.id);
  if (pois.length === 0) {
    await ctx.reply(
      'Список мест пуст. Скажи, например: «запиши это кафе, отличный кофе» или ' +
        '«добавь в места — смотровая площадка, хочу сходить» — и я сохраню точку с ссылкой на карту.',
    );
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
    await ctx.reply('Использование: /delpoi <id> (id смотри в /poi)');
    return;
  }
  const ok = deletePoi(id, ctx.chat.id);
  await ctx.reply(ok ? `🗑 Точка #${id} удалена.` : `Не нашёл точку #${id} в этом чате.`);
}
