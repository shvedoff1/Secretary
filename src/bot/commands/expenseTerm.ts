import type { Context } from 'grammy';
import {
  listExpenseTerms,
  addExpenseTerms,
  clearExpenseTerms,
} from '../../db/repos/expenseTerm.repo.js';

const CLEAR_ARGS = new Set(['clear', 'reset', 'очистить', 'сброс', 'забудь']);

/**
 * `/trata` — show the words this chat has taught the bot to treat as expenses.
 * `/trata <слово, ещё слово>` — add trigger words directly (comma/newline separated).
 * `/trata clear` (reset/очистить/сброс) — wipe the learned expense dictionary.
 *
 * The usual way to teach a word is to reply to a missed message with «запомни,
 * это трата»; this command is for inspecting and managing that list by hand.
 */
export async function cmdTrata(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();

  if (CLEAR_ARGS.has(arg.toLowerCase())) {
    clearExpenseTerms(ctx.chat.id);
    await ctx.reply('🧹 Выученный словарь трат очищен.');
    return;
  }

  if (arg) {
    const terms = arg
      .split(/[,\n;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const added = addExpenseTerms(ctx.chat.id, terms, ctx.from?.id ?? null);
    if (added.length === 0) {
      await ctx.reply('Уже знаю такие слова — ничего нового не добавил.');
      return;
    }
    const list = added.map((t) => `«${t}»`).join(', ');
    await ctx.reply(`✍️ Добавил в словарь трат: ${list}.`);
    return;
  }

  const entries = listExpenseTerms(ctx.chat.id);
  if (entries.length === 0) {
    await ctx.reply(
      'Словарь трат пуст. Ответь на сообщение, которое я пропустил, и напиши ' +
        '«запомни, это трата» — или добавь словом: /trata дошик, на бензин. ' +
        '(Сброс: /trata clear)',
    );
    return;
  }

  const lines = entries.map((e) => `• ${e.term}`);
  await ctx.reply(
    `💸 Слова, которые я считаю тратами:\n${lines.join('\n')}\n\n` +
      'Добавить: /trata <слово>. Сброс: /trata clear',
  );
}
