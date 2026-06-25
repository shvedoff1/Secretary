import type { Context } from 'grammy';
import {
  appendMemory,
  clearMemory,
  listMemoryLines,
  removeMemoryLine,
} from '../../db/repos/memory.repo.js';
import { clearTurns } from '../../db/repos/conversation.repo.js';

export async function cmdMemory(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const lines = listMemoryLines(ctx.chat.id);
  if (lines.length === 0) {
    await ctx.reply('Память чата пуста. Добавьте: /remember <текст>');
    return;
  }
  const body = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  await ctx.reply(
    `🧠 Память чата:\n${body}\n\n` +
      'Забыть один пункт: /forget <номер>. Стереть всё (и историю диалога): /forget',
  );
}

export async function cmdRemember(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const note = ((ctx.match as string | undefined) ?? '').trim();
  if (!note) {
    await ctx.reply('Использование: /remember <что запомнить>');
    return;
  }
  appendMemory(ctx.chat.id, note);
  await ctx.reply('🧠 Запомнил.');
}

export async function cmdForget(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();

  // `/forget <номер>` prunes a single stray note (e.g. an off-topic thing the bot
  // over-remembered) without nuking everything. Bare `/forget` wipes memory AND
  // the dialogue history — the full reset.
  if (arg) {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) {
      await ctx.reply(
        'Использование: /forget <номер пункта из /memory> — или /forget без номера, чтобы стереть всё.',
      );
      return;
    }
    const removed = removeMemoryLine(ctx.chat.id, n);
    if (removed === null) {
      await ctx.reply(`Нет пункта №${n}. Посмотреть список: /memory`);
      return;
    }
    await ctx.reply(`🧹 Забыл: ${removed}`);
    return;
  }

  clearMemory(ctx.chat.id);
  clearTurns(ctx.chat.id);
  await ctx.reply('🧹 Память и история диалога очищены.');
}
