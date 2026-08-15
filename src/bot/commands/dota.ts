import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { isAdmin } from '../../db/repos/users.repo.js';
import {
  countDotaEntities,
  findDotaEntity,
  getDotaSyncState,
  searchDotaEntities,
} from '../../db/repos/dota.repo.js';
import { runDotaSync } from '../../dota/sync.js';
import { replyLong } from '../../util/telegramText.js';

/**
 * /dota — inspect and drive the Dota knowledge base (admin, in the DM):
 *   /dota            — status: patch, row counts, last sync, last error
 *   /dota sync       — force a full rebuild now (~5 min, ~550 requests)
 *   /dota <название> — preview the card the assistant would be handed
 *
 * The base itself is global reference data refreshed by the nightly job; this
 * command exists so a wrong answer in the chat can be traced to the stored card.
 */
export async function cmdDota(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    if (ctx.chat?.type === 'private') await ctx.reply('Команда только для администратора.');
    return;
  }

  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const cfg = loadConfig();

  if (!cfg.ENABLE_DOTA) {
    await ctx.reply('База по доте выключена (ENABLE_DOTA=false).');
    return;
  }

  if (arg.toLowerCase() === 'sync') {
    await ctx.reply('🔄 Запускаю пересборку базы — это несколько минут, напишу когда закончу.');
    const result = await runDotaSync(true);
    if (result.status === 'failed') {
      await ctx.reply(`⚠️ Синк упал: ${result.error}\nСтарые данные остались на месте.`);
      return;
    }
    const c = result.counts;
    await ctx.reply(
      `✅ Синк готов (${result.status}). Патч ${result.patch ?? '?'}: ${c?.hero ?? 0} героев, ${c?.item ?? 0} предметов, ${c?.patch ?? 0} блоков изменений.`,
    );
    return;
  }

  if (arg) {
    const entity = findDotaEntity(arg, null) ?? findDotaEntity(arg, 'patch');
    if (entity) {
      // Plain text on purpose: this is the raw card as the model receives it, so
      // any markdown in it must be shown, not rendered.
      await replyLong(ctx, entity.card);
      return;
    }
    const near = searchDotaEntities(arg, 8);
    await ctx.reply(
      near.length > 0
        ? `Не нашёл «${arg}». Похожее: ${near.map((e) => e.name).join(', ')}`
        : `Не нашёл «${arg}» в базе.`,
    );
    return;
  }

  const state = getDotaSyncState();
  const counts = countDotaEntities();
  const when = (ms: number | null): string =>
    ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'никогда';
  await ctx.reply(
    [
      `🎮 База по доте — патч ${state.patch ?? 'нет данных'}`,
      `Героев: ${counts.hero} · предметов: ${counts.item} · блоков изменений: ${counts.patch}`,
      `Полный синк: ${when(state.lastFullSync)} · последняя проверка: ${when(state.lastCheck)}`,
      `Ночной час синка: ${cfg.DOTA_SYNC_HOUR_UTC}:00 UTC`,
      state.lastError ? `⚠️ Последняя ошибка: ${state.lastError}` : null,
      '',
      'Пересобрать: /dota sync · Посмотреть карточку: /dota <название>',
    ]
      .filter((l): l is string => l !== null)
      .join('\n'),
  );
}
