import type { Context } from 'grammy';
import { getLexicon, clearLexicon } from '../../db/repos/lexicon.repo.js';
import { isAdmin } from '../../db/repos/users.repo.js';
import { replyLong } from '../../util/telegramText.js';

const CLEAR_ARGS = new Set(['clear', 'reset', 'очистить', 'сброс', 'забудь']);

/**
 * Split the argument string into an optional leading chat id and the rest.
 * A chat id is a (possibly negative) integer — Telegram group ids are negative,
 * so `/slang -100123` targets that chat while `/slang clear` does not.
 */
function parseSlangArgs(raw: string): { chatId: number | null; rest: string } {
  const trimmed = raw.trim();
  const m = /^(-?\d+)\b\s*([\s\S]*)$/.exec(trimmed);
  if (m) {
    const id = Number(m[1]);
    if (Number.isInteger(id) && id !== 0) {
      return { chatId: id, rest: m[2]!.trim() };
    }
  }
  return { chatId: null, rest: trimmed };
}

/**
 * `/slang` — show the slang/distorted words the bot has picked up from the chat.
 * `/slang clear` (reset/очистить/сброс) — wipe the learned lexicon for this chat.
 *
 * Admins can also target another chat from a private chat with the bot:
 * `/slang <chatId>` shows that chat's slang, `/slang <chatId> clear` wipes it —
 * so the group's learned lingo can be inspected/reset from the DM (a group's
 * lexicon is otherwise invisible from anywhere else).
 */
export async function cmdSlang(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const { chatId, rest } = parseSlangArgs((ctx.match as string | undefined) ?? '');

  // Targeting another chat by id is an admin-only inspection from the DM. Reading
  // one chat's slang while sitting in another would leak between chats, so gate it.
  const targetId = chatId ?? ctx.chat.id;
  if (chatId !== null && chatId !== ctx.chat.id && !isAdmin(ctx.from?.id ?? 0)) {
    await ctx.reply('Чужой чат по id смотрит только администратор.');
    return;
  }

  const arg = rest.toLowerCase();
  const forOther = targetId !== ctx.chat.id;

  if (CLEAR_ARGS.has(arg)) {
    clearLexicon(targetId);
    await ctx.reply(forOther ? `🧹 Сленг чата ${targetId} очищен.` : '🧹 Выученный сленг очищен.');
    return;
  }

  const entries = getLexicon(targetId);
  if (entries.length === 0) {
    await ctx.reply(
      forOther
        ? `У чата ${targetId} пока нет выученных словечек.`
        : 'Пока не набрал ваших словечек — поболтайте, со временем подхвачу. (Сброс: /slang clear)',
    );
    return;
  }

  const lines = entries.map((e) =>
    e.gloss ? `• ${e.term} — ${e.gloss} (×${e.frequency})` : `• ${e.term} (×${e.frequency})`,
  );
  const header = forOther ? `🗣️ Словечки чата ${targetId}:` : '🗣️ Словечки чата:';
  const footer = forOther ? `Сброс: /slang ${targetId} clear` : 'Сброс: /slang clear';
  // The lexicon is unbounded, so this list can outgrow Telegram's 4096-char cap
  // in a chatty group — chunk it instead of letting the send silently 400.
  await replyLong(ctx, `${header}\n${lines.join('\n')}\n\n${footer}`);
}
