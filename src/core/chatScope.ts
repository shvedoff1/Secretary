import { getChatConfig } from '../db/repos/chatConfig.repo.js';

/**
 * Which features live in which kind of chat. Telegram gives private chats the
 * user's (positive) id and groups/supergroups/channels negative ids, so the kind
 * is decidable from the id alone — the scheduler and inline paths have no ctx.
 *
 * The split is a product decision: the CALORIE DIARY is personal and lives in
 * the DM only; SHARED EXPENSES (Splid, receipts) are a group thing and live in
 * group chats only. Keeping them apart means neither tool is even offered where
 * the other belongs, so «съел шаурму за 300» can't be misrouted either way.
 * Every call site reads these helpers — never `chatId > 0` inline.
 */
export function isPrivateChat(chatId: number): boolean {
  return chatId > 0;
}

/** The calorie diary (log_food / food_report / /food) — private chats only. */
export function foodAllowedIn(chatId: number): boolean {
  return isPrivateChat(chatId);
}

/** Shared expenses (record_expense / spending_report / the spend scan) — groups only. */
export function expensesAllowedIn(chatId: number): boolean {
  return !isPrivateChat(chatId);
}

/**
 * Is Splid ACTIVE here: a group is connected AND this kind of chat may record
 * expenses. A Splid group linked from a DM before the split stays stored but
 * inert — the DM simply has no expense tools.
 */
export function splidActiveIn(chatId: number): boolean {
  return expensesAllowedIn(chatId) && !!getChatConfig(chatId)?.provider_group_id;
}
