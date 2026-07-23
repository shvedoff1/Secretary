import { InlineKeyboard } from 'grammy';

// Callback data scheme (kept short for Telegram's 64-byte limit):
//   e:ok:<pendingId>   confirm
//   e:no:<pendingId>   cancel
//   e:ed:<pendingId>   edit (reword)
//   e:rt:<pendingId>   retry submit
//   u:ap:<tgUserId>    approve user
//   u:dn:<tgUserId>    deny user
//   m:d:<chatId>       set chat mode dota (+trust)
//   m:s:<chatId>       set chat mode secretary (+trust)
//   m:t:<chatId>       set chat mode tutor (+trust)
//   m:x:<chatId>       ignore chat (leave untrusted)

export function previewKeyboard(pendingId: string, retriable = false): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✅ Записать', `e:ok:${pendingId}`)
    .text('✏️ Исправить', `e:ed:${pendingId}`)
    .text('❌ Отмена', `e:no:${pendingId}`);
  if (retriable) {
    kb.row().text('🔁 Повторить', `e:rt:${pendingId}`);
  }
  return kb;
}

export function approvalKeyboard(tgUserId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Approve', `u:ap:${tgUserId}`)
    .text('❌ Deny', `u:dn:${tgUserId}`);
}

/** Mode picker on the "bot was added to a chat" admin DM. Picking a mode also
 *  TRUSTS the chat (participants pass the auth gate); ignore leaves it silent. */
export function modeKeyboard(chatId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎮 Дота', `m:d:${chatId}`)
    .text('🤙 Секретарь', `m:s:${chatId}`)
    .text('🎓 Репетитор', `m:t:${chatId}`)
    .row()
    .text('🚫 Игнорить', `m:x:${chatId}`);
}
