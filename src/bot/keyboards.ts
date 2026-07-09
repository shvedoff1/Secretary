import { InlineKeyboard } from 'grammy';
import { t } from '../i18n/index.js';

// Callback data scheme (kept short for Telegram's 64-byte limit):
//   e:ok:<pendingId>   confirm
//   e:no:<pendingId>   cancel
//   e:ed:<pendingId>   edit (reword)
//   e:rt:<pendingId>   retry submit
//   u:ap:<tgUserId>    approve user
//   u:dn:<tgUserId>    deny user

export function previewKeyboard(pendingId: string, retriable = false): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(t('kb.record'), `e:ok:${pendingId}`)
    .text(t('kb.edit'), `e:ed:${pendingId}`)
    .text(t('kb.cancel'), `e:no:${pendingId}`);
  if (retriable) {
    kb.row().text(t('kb.retry'), `e:rt:${pendingId}`);
  }
  return kb;
}

export function approvalKeyboard(tgUserId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('kb.approve'), `u:ap:${tgUserId}`)
    .text(t('kb.deny'), `u:dn:${tgUserId}`);
}
