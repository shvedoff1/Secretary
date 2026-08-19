import { InlineKeyboard } from 'grammy';
import { MODES } from '../modes.js';

// Callback data scheme (kept short for Telegram's 64-byte limit):
//   e:ok:<pendingId>   confirm
//   e:no:<pendingId>   cancel
//   e:ed:<pendingId>   edit (reword)
//   e:rt:<pendingId>   retry submit
//   u:ap:<tgUserId>    approve user
//   u:dn:<tgUserId>    deny user
//   m:<code>:<chatId>  set the chat's mode (+trust); <code> comes from src/modes.ts
//                      (s = secretary, a = assistant, d = dota, t = tutor)
//   m:?:<chatId>       show what the modes are (the picker stays on screen)
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

/**
 * Mode picker: shown on the "bot was added to a chat" admin DM and by `/mode
 * <chatId>`. Picking a mode also TRUSTS the chat (participants pass the auth
 * gate); «Игнорить» leaves it silent. Buttons are generated from the mode
 * registry, so a new mode shows up here automatically — two per row to keep the
 * labels readable on a phone, then the info/ignore row.
 */
export function modeKeyboard(chatId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  MODES.forEach((m, i) => {
    kb.text(m.label, `m:${m.code}:${chatId}`);
    if (i % 2 === 1 && i < MODES.length - 1) kb.row();
  });
  return kb.row().text('ℹ️ Что за режимы?', `m:?:${chatId}`).text('🚫 Игнорить', `m:x:${chatId}`);
}
