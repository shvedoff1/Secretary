import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import {
  insertPinned,
  removeMemoryItem,
  clearMemoryItems,
  listMemoryItemsForDisplay,
} from '../../db/repos/memoryItem.repo.js';
import { clearTurns } from '../../db/repos/conversation.repo.js';

export async function cmdMemory(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const items = listMemoryItemsForDisplay(ctx.chat.id, loadConfig().MEMORY_HALFLIFE_DAYS);
  if (items.length === 0) {
    await ctx.reply('Память чата пуста. Добавьте: /remember <текст>');
    return;
  }
  // 📌 marks a pinned (explicitly remembered) fact; "→ Имя" tags a per-person fact.
  const body = items
    .map((it, i) => {
      const pin = it.pinned ? '📌 ' : '';
      const who = it.scope === 'user' && it.subject ? ` (→ ${it.subject})` : '';
      return `${i + 1}. ${pin}${it.content}${who}`;
    })
    .join('\n');
  await ctx.reply(
    `🧠 Память чата:\n${body}\n\n` +
      '📌 — закреплено (не забывается). Забыть один пункт: /forget <номер>. ' +
      'Стереть всё (и историю диалога): /forget',
  );
}

export async function cmdRemember(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const note = ((ctx.match as string | undefined) ?? '').trim();
  if (!note) {
    await ctx.reply('Использование: /remember <что запомнить>');
    return;
  }
  insertPinned(ctx.chat.id, note);
  await ctx.reply('🧠 Запомнил.');
}

export async function cmdForget(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const arg = ((ctx.match as string | undefined) ?? '').trim();

  // `/forget <номер>` prunes a single entry (e.g. an off-topic thing the bot
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
    // Map the shown 1-based index back to a real row id via the same stable order.
    const items = listMemoryItemsForDisplay(ctx.chat.id, loadConfig().MEMORY_HALFLIFE_DAYS);
    const target = items[n - 1];
    if (!target) {
      await ctx.reply(`Нет пункта №${n}. Посмотреть список: /memory`);
      return;
    }
    const removed = removeMemoryItem(ctx.chat.id, target.id);
    await ctx.reply(`🧹 Забыл: ${removed ?? target.content}`);
    return;
  }

  clearMemoryItems(ctx.chat.id);
  clearTurns(ctx.chat.id);
  await ctx.reply('🧹 Память и история диалога очищены.');
}
