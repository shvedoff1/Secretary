import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { canManageChat } from '../permissions.js';
import { setChatMode, setChatTitle, setChatTrusted } from '../../db/repos/chatSettings.repo.js';
import { modeByCode, renderModeCard } from '../../modes.js';
import { modeKeyboard } from '../keyboards.js';

/**
 * The "bot was added to a chat" onboarding. Telegram delivers a `my_chat_member`
 * update when the bot's own membership changes; on a fresh join to a group the
 * admin gets a DM with the chat's name/id and a mode picker. Picking a mode both
 * sets the persona AND trusts the chat, so every participant immediately passes
 * the default-deny auth gate — one tap and /ping works for the whole squad.
 * «Игнорить» leaves the chat untrusted (the bot stays silent there).
 *
 * NOTE: this handler is registered BEFORE the auth gate — the person adding the
 * bot to a chat is usually not whitelisted, and the join event must still reach
 * the admin. It only ever DMs the admin, so there's nothing here to abuse.
 */
export async function onBotMembership(ctx: Context): Promise<void> {
  const upd = ctx.myChatMember;
  if (!upd || upd.chat.type === 'private') return;

  const was = upd.old_chat_member.status;
  const now = upd.new_chat_member.status;
  const joined =
    (was === 'left' || was === 'kicked') && (now === 'member' || now === 'administrator');
  const removed =
    (now === 'left' || now === 'kicked') && (was === 'member' || was === 'administrator');
  if (!joined && !removed) return; // e.g. member → administrator promotions

  const cfg = loadConfig();
  const title = 'title' in upd.chat && upd.chat.title ? upd.chat.title : '(без названия)';
  // Remember the chat's name so /chats can show it instead of a bare id.
  if ('title' in upd.chat && upd.chat.title) setChatTitle(upd.chat.id, upd.chat.title);
  const by = [upd.from.first_name, upd.from.last_name].filter(Boolean).join(' ') || upd.from.id;

  try {
    if (joined) {
      await ctx.api.sendMessage(
        cfg.ADMIN_TELEGRAM_ID,
        `🆕 Меня добавили в чат «${title}»\nid: ${upd.chat.id}\nдобавил: ${by}\n\n` +
          `Выбери режим — это откроет доступ всем участникам чата. Не знаешь, какой — ` +
          `жми «Что за режимы?», там описания. «Игнорить» — оставить чат без доступа ` +
          `(я буду молчать).`,
        { reply_markup: modeKeyboard(upd.chat.id) },
      );
    } else {
      // Removal note: revoke trust so a re-add starts from the safe default.
      setChatTrusted(upd.chat.id, false);
      await ctx.api.sendMessage(
        cfg.ADMIN_TELEGRAM_ID,
        `👋 Меня удалили из чата «${title}» (id: ${upd.chat.id}). Доверие к чату снято.`,
      );
    }
  } catch (err) {
    logger.warn({ err, chatId: upd.chat.id }, 'could not notify admin about membership change');
  }
}

/** Callback handler for the mode-picker buttons (prefix `m:`). The chat id is in
 * the callback data, so the gate is per chat: supreme admins always pass, chat
 * admins only for their own chats (they get this keyboard from /mode <id>). */
export async function handleModeCallback(ctx: Context): Promise<void> {
  const parts = (ctx.callbackQuery?.data ?? '').split(':');
  const code = parts[1];
  const chatId = Number(parts[2]);
  if (!code || !Number.isInteger(chatId) || chatId === 0) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (!ctx.from || !canManageChat(ctx.from.id, chatId)) {
    await ctx.answerCallbackQuery({ text: 'Только админ этого чата.' });
    return;
  }

  // «Что за режимы?» — describe them and keep the picker on screen, so the admin
  // can read what each one does and pick right there. This is the whole selector
  // flow: added to a chat → see the modes → choose.
  if (code === '?') {
    await ctx.answerCallbackQuery();
    await editSafe(
      ctx,
      `Режимы для чата ${chatId}:\n\n${renderModeCard()}\n\nВыбор режима открывает доступ всем участникам чата.`,
      modeKeyboard(chatId),
    );
    return;
  }

  if (code === 'x') {
    setChatTrusted(chatId, false);
    await ctx.answerCallbackQuery({ text: 'Игнорим' });
    await editSafe(ctx, `🚫 Чат ${chatId} оставлен без доступа — молчу там.`);
    return;
  }

  const spec = modeByCode(code);
  if (!spec) {
    await ctx.answerCallbackQuery();
    return;
  }
  setChatMode(chatId, spec.mode);
  setChatTrusted(chatId, true);
  await ctx.answerCallbackQuery({ text: 'Готово' });
  await editSafe(
    ctx,
    `✅ Чат ${chatId} → ${spec.label}, доступ открыт всем участникам.\n` +
      `Сменить: /mode ${chatId} — покажу список кнопками · закрыть доступ: /trust ${chatId} off`,
  );
  // Say hi in the chat so the squad sees the bot is live. Best-effort: the admin
  // action already succeeded; a failed greeting must not roll anything back.
  try {
    await ctx.api.sendMessage(chatId, spec.greeting);
  } catch (err) {
    logger.warn({ err, chatId }, 'could not greet the newly configured chat');
  }
}

async function editSafe(
  ctx: Context,
  text: string,
  keyboard?: ReturnType<typeof modeKeyboard>,
): Promise<void> {
  try {
    await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : undefined);
  } catch {
    /* message may be too old to edit (or identical text — the info card re-tapped) */
  }
}
