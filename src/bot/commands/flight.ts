import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import {
  listFlightWatches,
  deleteFlightWatch,
  forceFlightCheck,
} from '../../db/repos/flightWatch.repo.js';
import { getTimezone } from '../../db/repos/chatSettings.repo.js';
import { formatInTimezone } from '../../util/schedule.js';

/**
 * /flight — flight watches of this chat:
 *   /flight            — list active watches
 *   /flight del <id>   — disarm one
 *   /flight check <id> — force a poll now (picked up by the next minute tick)
 * Watches are created in plain words («следи за рейсом K6829 и напиши, если отменят»).
 */
export async function cmdFlight(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const arg = ((ctx.match as string | undefined) ?? '').trim();
  const [sub, idArg] = arg.split(/\s+/);

  if (sub === 'del' || sub === 'check') {
    const id = Number(idArg);
    if (!idArg || !Number.isInteger(id)) {
      await ctx.reply(`Использование: /flight ${sub} <id> (id смотри в /flight)`);
      return;
    }
    if (sub === 'del') {
      const ok = deleteFlightWatch(id, chatId);
      await ctx.reply(
        ok ? `🗑 Слежка #${id} снята.` : `Не нашёл слежку #${id} в этом чате.`,
      );
    } else {
      const ok = forceFlightCheck(id, chatId);
      await ctx.reply(
        ok
          ? `🛩 Проверю #${id} в течение минуты — если что-то поменялось, напишу.`
          : `Не нашёл активную слежку #${id} в этом чате.`,
      );
    }
    return;
  }

  const watches = listFlightWatches(chatId);
  if (watches.length === 0) {
    await ctx.reply(
      'За рейсами сейчас не слежу. Скажи, например: «следи за рейсом K6829 и напиши, если его отменят или перенесут».',
    );
    return;
  }
  const tz = getTimezone(chatId) ?? loadConfig().DEFAULT_TIMEZONE;
  const lines = watches.map((w) => {
    const next = formatInTimezone(Math.max(w.nextCheckAt, Date.now()), tz);
    const until = formatInTimezone(w.expiresAt, tz);
    const date = w.flightDate ? ` на ${w.flightDate}` : '';
    const fails = w.failCount > 0 ? ` ⚠️ ${w.failCount} неудачных попыток подряд` : '';
    return `🛩 #${w.id} «${w.title}» — рейс ${w.flight}${date}, каждые ${w.intervalMinutes} мин, следующая проверка ${next}, слежу до ${until}${fails}`;
  });
  await ctx.reply(
    [
      '🛩 Слежки за рейсами:',
      ...lines,
      '',
      'Снять: /flight del <id> · Проверить сейчас: /flight check <id>',
    ].join('\n'),
  );
}
