import type { Context } from 'grammy';
import { getLexicon, clearLexicon } from '../../db/repos/lexicon.repo.js';

const CLEAR_ARGS = new Set(['clear', 'reset', 'очистить', 'сброс', 'забудь']);

/**
 * `/slang` — show the slang/distorted words the bot has picked up from the chat.
 * `/slang clear` (reset/очистить/сброс) — wipe the learned lexicon for this chat.
 */
export async function cmdSlang(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim().toLowerCase();

  if (CLEAR_ARGS.has(arg)) {
    clearLexicon(ctx.chat.id);
    await ctx.reply('🧹 Выученный сленг очищен.');
    return;
  }

  const entries = getLexicon(ctx.chat.id);
  if (entries.length === 0) {
    await ctx.reply(
      'Пока не набрал ваших словечек — поболтайте, со временем подхвачу. (Сброс: /slang clear)',
    );
    return;
  }

  const lines = entries.map((e) =>
    e.gloss ? `• ${e.term} — ${e.gloss} (×${e.frequency})` : `• ${e.term} (×${e.frequency})`,
  );
  await ctx.reply(`🗣️ Словечки чата:\n${lines.join('\n')}\n\nСброс: /slang clear`);
}
