// i18n catalog: core namespace. Populated by the i18n migration.
// The 'en' half is typed against the 'ru' key set so every key must be translated.
export const coreRu = {
  // auth.* — access gate (src/bot/middleware/auth.ts)
  'auth.denied':
    'Доступ закрыт. Отправьте /request, чтобы запросить доступ у администратора.',
  'auth.noAccess': 'Нет доступа.',

  // chat.* — message/photo/voice handlers
  'chat.connectGroupForReceipts':
    'Подключите группу Splid командой /group <код>, чтобы я разбирал чеки.',
  'chat.receiptDownloadFailed': 'Не смог скачать фото чека, попробуйте ещё раз.',
  'chat.voiceTranscriptDm': '🎤 Голосовое ({chat}, {from}) расшифровалось как:\n\n{transcript}',
  'chat.dmChatLabel': 'личка',
  'chat.someone': 'кто-то',
  'chat.voiceNotConfigured': 'Распознавание голоса не настроено. Напиши текстом, пожалуйста.',
  'chat.voiceTranscribeFailed': 'Не смог распознать голосовое, попробуй ещё раз.',
  'chat.voiceNoSpeech': 'Не расслышал — в голосовом не было речи.',

  // preview.* — expense draft preview (src/bot/flows/preview.ts)
  'preview.title': '🧾 {title}',
  'preview.amount': '💰 {amount}',
  'preview.paidBy': '👤 Платил: {names}',
  'preview.splitAmong': '👥 Делим на: {who}',
  'preview.unresolved': '⚠️ Не распознаны: {names}',
  'preview.roster': 'Участники группы: {names}',
  'preview.clarifyHint': '✏️ Ответь на это сообщение и уточни, кто это (напр. «это Миша»).',
  'preview.notes': '📝 {notes}',
  'preview.lowConfidence': '🤔 Не очень уверен ({pct}%) — проверьте.',
  'preview.profiteerFixed': '{name} (фикс.)',

  // confirm.* — confirmation/submit flow (src/bot/flows/confirm.ts)
  'confirm.recorded': '✅ Записано в {provider}',
  'confirm.editHint': 'Ответьте на это сообщение исправленным текстом — я пересоберу трату.',
  'confirm.cancelledToast': 'Отменено',
  'confirm.cancelled': '❌ Отменено.',
  'confirm.alreadyProcessed': 'Уже обработано.',
  'confirm.nothingToRetry': 'Нечего повторять.',
  'confirm.fixUnresolvedFirst': 'Сначала исправьте нераспознанных участников (✏️).',
  'confirm.chatNotConfigured': 'Чат не настроен (/group).',
  'confirm.recording': 'Записываю…',
  'confirm.submitFailed': '⚠️ Не удалось записать: {msg}',
  'confirm.canRetry': '\nМожно повторить.',

  // kb.* — inline keyboard button labels (src/bot/keyboards.ts)
  'kb.record': '✅ Записать',
  'kb.edit': '✏️ Исправить',
  'kb.cancel': '❌ Отмена',
  'kb.retry': '🔁 Повторить',
  'kb.approve': '✅ Approve',
  'kb.deny': '❌ Deny',
} as const;

export const coreEn: Record<keyof typeof coreRu, string> = {
  'auth.denied': 'Access denied. Send /request to ask an administrator for access.',
  'auth.noAccess': 'No access.',

  'chat.connectGroupForReceipts':
    'Connect a Splid group with /group <code> so I can parse receipts.',
  'chat.receiptDownloadFailed': "Couldn't download the receipt photo, please try again.",
  'chat.voiceTranscriptDm': '🎤 Voice message ({chat}, {from}) transcribed as:\n\n{transcript}',
  'chat.dmChatLabel': 'DM',
  'chat.someone': 'someone',
  'chat.voiceNotConfigured': 'Voice recognition is not set up. Please write it as text.',
  'chat.voiceTranscribeFailed': "Couldn't recognize the voice message, please try again.",
  'chat.voiceNoSpeech': "Couldn't make it out — there was no speech in the voice message.",

  'preview.title': '🧾 {title}',
  'preview.amount': '💰 {amount}',
  'preview.paidBy': '👤 Paid: {names}',
  'preview.splitAmong': '👥 Split among: {who}',
  'preview.unresolved': '⚠️ Not recognized: {names}',
  'preview.roster': 'Group members: {names}',
  'preview.clarifyHint':
    '✏️ Reply to this message and clarify who this is (e.g. "it\'s Misha").',
  'preview.notes': '📝 {notes}',
  'preview.lowConfidence': '🤔 Not very sure ({pct}%) — please check.',
  'preview.profiteerFixed': '{name} (fixed)',

  'confirm.recorded': '✅ Recorded in {provider}',
  'confirm.editHint': "Reply to this message with the corrected text — I'll rebuild the expense.",
  'confirm.cancelledToast': 'Cancelled',
  'confirm.cancelled': '❌ Cancelled.',
  'confirm.alreadyProcessed': 'Already processed.',
  'confirm.nothingToRetry': 'Nothing to retry.',
  'confirm.fixUnresolvedFirst': 'First fix the unrecognized participants (✏️).',
  'confirm.chatNotConfigured': 'Chat is not configured (/group).',
  'confirm.recording': 'Recording…',
  'confirm.submitFailed': "⚠️ Couldn't record: {msg}",
  'confirm.canRetry': '\nYou can retry.',

  'kb.record': '✅ Record',
  'kb.edit': '✏️ Edit',
  'kb.cancel': '❌ Cancel',
  'kb.retry': '🔁 Retry',
  'kb.approve': '✅ Approve',
  'kb.deny': '❌ Deny',
};
