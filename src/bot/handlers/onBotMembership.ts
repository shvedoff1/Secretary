import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isAdmin } from '../../db/repos/users.repo.js';
import {
  setChatMode,
  setChatTrusted,
  type ChatMode,
} from '../../db/repos/chatSettings.repo.js';
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
  const by = [upd.from.first_name, upd.from.last_name].filter(Boolean).join(' ') || upd.from.id;

  try {
    if (joined) {
      await ctx.api.sendMessage(
        cfg.ADMIN_TELEGRAM_ID,
        `🆕 Меня добавили в чат «${title}»\nid: ${upd.chat.id}\nдобавил: ${by}\n\n` +
          `Выбери режим — это откроет доступ всем участникам чата. «Игнорить» — ` +
          `оставить чат без доступа (я буду молчать).`,
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

// What the bot says in the chat right after the admin picks a mode — instant
// feedback for the group that the bot is live, in the chosen persona's voice.
const MODE_GREETING: Record<ChatMode, string> = {
  dota: 'Так, класс, ваш учитель по доте на месте. Записывайтесь на урок: /ping add @ник …, сбор — /ping. Опоздавших отмечаю в журнале.',
  secretary: 'Йоу, я на связи! Чем могу — /help. 🤙',
  tutor: 'Привет! Я репетитор. Присылай задачу — разберём по шагам.',
};

const MODE_BY_CODE: Record<string, ChatMode> = { d: 'dota', s: 'secretary', t: 'tutor' };

const MODE_DONE_LABEL: Record<ChatMode, string> = {
  dota: '🎮 дота',
  secretary: '🤙 секретарь',
  tutor: '🎓 репетитор',
};

/** Callback handler for the mode-picker buttons (prefix `m:`, admin only). */
export async function handleModeCallback(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Только администратор.' });
    return;
  }
  const parts = (ctx.callbackQuery?.data ?? '').split(':');
  const code = parts[1];
  const chatId = Number(parts[2]);
  if (!code || !Number.isInteger(chatId) || chatId === 0) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (code === 'x') {
    setChatTrusted(chatId, false);
    await ctx.answerCallbackQuery({ text: 'Игнорим' });
    await editSafe(ctx, `🚫 Чат ${chatId} оставлен без доступа — молчу там.`);
    return;
  }

  const mode = MODE_BY_CODE[code];
  if (!mode) {
    await ctx.answerCallbackQuery();
    return;
  }
  setChatMode(chatId, mode);
  setChatTrusted(chatId, true);
  await ctx.answerCallbackQuery({ text: 'Готово' });
  await editSafe(
    ctx,
    `✅ Чат ${chatId} → ${MODE_DONE_LABEL[mode]}, доступ открыт всем участникам.\n` +
      `Сменить: /mode ${chatId} <режим> · закрыть доступ: /trust ${chatId} off`,
  );
  // Say hi in the chat so the squad sees the bot is live. Best-effort: the admin
  // action already succeeded; a failed greeting must not roll anything back.
  try {
    await ctx.api.sendMessage(chatId, MODE_GREETING[mode]);
  } catch (err) {
    logger.warn({ err, chatId }, 'could not greet the newly configured chat');
  }
}

async function editSafe(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text);
  } catch {
    /* message may be too old to edit */
  }
}
