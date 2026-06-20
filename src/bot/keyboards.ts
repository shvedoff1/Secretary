import { InlineKeyboard } from 'grammy';

// Callback data scheme (kept short for Telegram's 64-byte limit):
//   e:ok:<pendingId>   confirm
//   e:no:<pendingId>   cancel
//   e:ed:<pendingId>   edit (reword)
//   e:rt:<pendingId>   retry submit
//   u:ap:<tgUserId>    approve user
//   u:dn:<tgUserId>    deny user

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
