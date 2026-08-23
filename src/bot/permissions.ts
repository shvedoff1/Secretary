import { isAdmin, getUser, listSupremeAdmins } from '../db/repos/users.repo.js';
import {
  countManagedChats,
  isChatAdmin,
  listChatAdmins,
  listManagedChats,
} from '../db/repos/chatAdmin.repo.js';
import { getChatTitle } from '../db/repos/chatSettings.repo.js';
import { getChatConfig } from '../db/repos/chatConfig.repo.js';

/**
 * The two-tier role model, kept deliberately flat:
 *  - a SUPREME admin ("верховный админ", users.role = 'admin') manages every
 *    chat, the whitelist, and appoints/dismisses chat admins and other supreme
 *    admins — that's how rights are handed over. The configured
 *    ADMIN_TELEGRAM_ID is re-ensured as one on every startup, so the owner
 *    always keeps full rights.
 *  - a CHAT admin (a chat_admin row) has every per-chat capability for the
 *    chats granted to them, and nothing bot-wide.
 */
export function isSupremeAdmin(tgUserId: number): boolean {
  return isAdmin(tgUserId);
}

/** May this user run per-chat admin commands against this chat? */
export function canManageChat(tgUserId: number, chatId: number): boolean {
  return isAdmin(tgUserId) || isChatAdmin(tgUserId, chatId);
}

/** Does this user administer anything at all (any chat, or the whole bot)? */
export function isBotManager(tgUserId: number): boolean {
  return isAdmin(tgUserId) || countManagedChats(tgUserId) > 0;
}

/** The chats a user may manage: 'all' for supreme admins, explicit ids otherwise. */
export function managedChatIds(tgUserId: number): number[] | 'all' {
  return isAdmin(tgUserId) ? 'all' : listManagedChats(tgUserId);
}

/** Human-readable label for a user id: name, @username, or the bare id. */
export function userLabel(tgUserId: number): string {
  const u = getUser(tgUserId);
  return u?.display_name ?? (u?.username ? `@${u.username}` : String(tgUserId));
}

/** Human-readable label for a chat id: recorded title, or the bare id. */
export function chatLabel(chatId: number): string {
  return getChatTitle(chatId) ?? getChatConfig(chatId)?.title ?? `чат ${chatId}`;
}

/**
 * Who runs the bot for this chat, as ready display labels — the supreme admins
 * first (marked as such), then the chat's own admins. Fed into the assistant's
 * context block so «кто ты и чей ты?» is answered with real names instead of a
 * guess (see the "Who you are" section of SYSTEM_PROMPT).
 */
export function botAdminLabels(chatId: number): string[] {
  const supreme = listSupremeAdmins();
  const supremeIds = new Set(supreme.map((a) => a.tg_user_id));
  const lines = supreme.map(
    (a) =>
      `${a.display_name ?? (a.username ? `@${a.username}` : `id ${a.tg_user_id}`)} (верховный админ)`,
  );
  for (const a of listChatAdmins(chatId)) {
    if (supremeIds.has(a.tg_user_id)) continue;
    lines.push(`${userLabel(a.tg_user_id)} (админ этого чата)`);
  }
  return lines;
}
