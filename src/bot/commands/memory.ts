import type { Context } from 'grammy';
import {
  getMemory,
  appendMemory,
  clearMemory,
} from '../../db/repos/memory.repo.js';
import { clearTurns } from '../../db/repos/conversation.repo.js';

export async function cmdMemory(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const content = getMemory(ctx.chat.id).trim();
  await ctx.reply(
    content ? `🧠 Память чата:\n${content}` : 'Память чата пуста. Добавьте: /remember <текст>',
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
  clearMemory(ctx.chat.id);
  clearTurns(ctx.chat.id);
  await ctx.reply('🧹 Память и история диалога очищены.');
}
