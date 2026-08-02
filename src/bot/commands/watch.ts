import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import {
  listWatches,
  deleteWatch,
  forceCheck,
} from '../../db/repos/pageWatch.repo.js';
import { getTimezone } from '../../db/repos/chatSettings.repo.js';
import { formatInTimezone } from '../../util/schedule.js';

/**
 * /watch — page watches ("вотчеры") of this chat:
 *   /watch            — list active watches
 *   /watch del <id>   — disarm one
 *   /watch check <id> — force a poll now (picked up by the next minute tick)
 * Watches are created in plain words («следи за страницей и напиши, когда …»).
 */
export async function cmdWatch(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const [sub, idArg] = arg.split(/\s+/);

  if (sub === 'del' || sub === 'check') {
    const id = Number(idArg);
    if (!idArg || !Number.isInteger(id)) {
      await ctx.reply(`Использование: /watch ${sub} <id> (id смотри в /watch)`);
      return;
    }
    if (sub === 'del') {
      const ok = deleteWatch(id, chatId);
      await ctx.reply(
        ok ? `🗑 Вотчер #${id} снят.` : `Не нашёл вотчер #${id} в этом чате.`,
      );
    } else {
      const ok = forceCheck(id, chatId);
      await ctx.reply(
        ok
          ? `👁 Проверю #${id} в течение минуты — если событие уже там, напишу.`
          : `Не нашёл активный вотчер #${id} в этом чате.`,
      );
    }
    return;
  }

  const watches = listWatches(chatId);
  if (watches.length === 0) {
    await ctx.reply(
      'Активных вотчеров нет. Скажи, например: «следи за https://… и напиши, когда появятся сеансы Титана».',
    );
    return;
  }
  const tz = getTimezone(chatId) ?? loadConfig().DEFAULT_TIMEZONE;
  const lines = watches.map((w) => {
    const next = formatInTimezone(Math.max(w.nextCheckAt, Date.now()), tz);
    const until = formatInTimezone(w.expiresAt, tz);
    const fails = w.failCount > 0 ? ` ⚠️ ${w.failCount} неудачных попыток подряд` : '';
    return `👁 #${w.id} «${w.title}» — каждые ${w.intervalMinutes} мин, следующая проверка ${next}, слежу до ${until}${fails}\n${w.url}`;
  });
  await ctx.reply(
    [
      '👁 Вотчеры страниц:',
      ...lines,
      '',
      'Снять: /watch del <id> · Проверить сейчас: /watch check <id>',
    ].join('\n'),
    { link_preview_options: { is_disabled: true } },
  );
}
