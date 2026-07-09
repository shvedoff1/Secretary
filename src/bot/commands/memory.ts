import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import {
  removeMemoryItem,
  clearMemoryItems,
  listMemoryItemsForDisplay,
} from '../../db/repos/memoryItem.repo.js';
import { clearTurns } from '../../db/repos/conversation.repo.js';
import { rememberNote } from '../flows/assist.js';
import { t } from '../../i18n/index.js';

export async function cmdMemory(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const items = listMemoryItemsForDisplay(ctx.chat.id, loadConfig().MEMORY_HALFLIFE_DAYS);
  if (items.length === 0) {
    await ctx.reply(t('memory.empty'));
    return;
  }
  // 📌 marks a pinned (explicitly remembered) fact; 🎭 a voice/style directive;
  // "→ Имя" tags a per-person fact.
  const body = items
    .map((it, i) => {
      const tag = it.scope === 'persona' ? '🎭 ' : it.pinned ? '📌 ' : '';
      const who = it.scope === 'user' && it.subject ? ` (→ ${it.subject})` : '';
      return `${i + 1}. ${tag}${it.content}${who}`;
    })
    .join('\n');
  await ctx.reply(t('memory.list', { body }));
}

export async function cmdRemember(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const note = ((ctx.match as string | undefined) ?? '').trim();
  if (!note) {
    await ctx.reply(t('memory.remember.usage'));
    return;
  }
  // rememberNote returns a localized confirmation; when it's the plain
  // "remembered" acknowledgement (no override), decorate it with 🧠. Compare
  // against the translated string so this works in every locale, not just ru.
  const reply = rememberNote(ctx.chat.id, note);
  await ctx.reply(reply === t('assist.remembered') ? `🧠 ${reply}` : reply);
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
      await ctx.reply(t('memory.forget.usage'));
      return;
    }
    // Map the shown 1-based index back to a real row id via the same stable order.
    const items = listMemoryItemsForDisplay(ctx.chat.id, loadConfig().MEMORY_HALFLIFE_DAYS);
    const target = items[n - 1];
    if (!target) {
      await ctx.reply(t('memory.forget.noItem', { n }));
      return;
    }
    const removed = removeMemoryItem(ctx.chat.id, target.id);
    await ctx.reply(t('memory.forget.removed', { item: removed ?? target.content }));
    return;
  }

  clearMemoryItems(ctx.chat.id);
  clearTurns(ctx.chat.id);
  await ctx.reply(t('memory.forget.cleared'));
}
