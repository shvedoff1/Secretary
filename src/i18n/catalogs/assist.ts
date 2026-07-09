// i18n catalog: assist namespace. Populated by the i18n migration.
// The 'en' half is typed against the 'ru' key set so every key must be translated.
export const assistRu = {
  'assist.looksLikeExpense':
    'Это похоже на трату — такое в память не пишу, для трат есть Splid. Если это правда трата — просто скажи её как трату, я оформлю. 🤙',
  'assist.remembered': 'Запомнил.',
  'assist.rememberedNoMatch':
    'Записал: {note}. Но старое, что нужно было заменить, не нашёл — глянь /memory, могло остаться противоречие.',
  'assist.rememberedTail': ' (часть старого не нашёл — глянь /memory)',
  'assist.rememberedReplaced':
    'Обновил — заменил «{removed}»{tail}. Теперь у меня записано: {note}',
  'assist.editMemoryNotFound':
    'Не нашёл в памяти «{find}». Глянь /memory — там точные формулировки, скажи какую менять.',
  'assist.editMemoryDone': 'Поправил: «{content}» → «{replace}». 🤙',
  'assist.scheduleBadCron':
    'Не понял расписание — уточни время (напр. «каждый день в 9 утра»).',
  'assist.scheduleInPast': 'Это расписание уже не сработает — уточни время.',
  'assist.scheduleDuplicate':
    'Это уже стоит — #{id} «{title}» (следующий запуск {when}).',
  'assist.taskKindOnce': 'Напоминание',
  'assist.taskKindRecurring': 'Регулярная задача',
  'assist.taskHumorNote': ' 😂 с юмором',
  'assist.taskCreated':
    '{kind} #{id} «{title}»{humorNote} создана. Первый запуск: {when} ({tz}). Список: /tasks',
  'assist.learnExpenseNothingNew':
    'Уже знаю такие слова — ничего нового не добавил.',
  'assist.learnExpenseDone':
    'Запомнил: сообщения со словами {list} теперь считаю тратами. Список: /trata',
  'assist.editLexiconDone': 'Готово — «{term}» теперь значит «{gloss}». 🤙',
  'assist.editLexiconNotFound':
    'Не нашёл «{term}» в словечках чата. Глянь /slang — там точные формы.',
  'assist.poiAdded': 'Добавил в места: {name}. Список: /poi',
  'assist.aiOverloaded':
    '⚠️ ИИ сейчас перегружен (529). Я уже несколько раз перепробовал — дай ему минутку и повтори. 🤙',
  'assist.aiError': '⚠️ Не получилось обратиться к ИИ. Попробуй ещё раз чуть позже.',
  'assist.connectSplid':
    'Чтобы записывать траты в Splid, подключи группу: /group <код-приглашения>. Это опционально — без него я и так помогу: напоминания, поиск, заметки. 🤙',
  'assist.beforeOpenAi': '🔬 До OpenAI:\n\n{text}',
  'assist.previewInactive': 'Это превью уже неактивно.',
  'assist.connectSplidReword': 'Сначала подключите группу Splid командой /group.',
  'assist.rewordNotUnderstood':
    'Не понял правку. Можешь переписать трату целиком, напр.: «такси 500 за меня и Колю».',
} as const;

export const assistEn: Record<keyof typeof assistRu, string> = {
  'assist.looksLikeExpense':
    "That looks like an expense — I don't save those to memory, Splid is for expenses. If it really is an expense — just tell me as an expense and I'll log it. 🤙",
  'assist.remembered': 'Got it.',
  'assist.rememberedNoMatch':
    "Saved: {note}. But I couldn't find the old fact that needed replacing — check /memory, a contradiction may remain.",
  'assist.rememberedTail': " (couldn't find some of the old facts — check /memory)",
  'assist.rememberedReplaced':
    'Updated — replaced "{removed}"{tail}. Now I have: {note}',
  'assist.editMemoryNotFound':
    'Couldn\'t find "{find}" in memory. Check /memory — it has the exact wording, tell me which one to change.',
  'assist.editMemoryDone': 'Fixed: "{content}" → "{replace}". 🤙',
  'assist.scheduleBadCron':
    'I didn\'t understand the schedule — clarify the time (e.g. «every day at 9am»).',
  'assist.scheduleInPast': "That schedule won't fire anymore — clarify the time.",
  'assist.scheduleDuplicate':
    'That\'s already set — #{id} "{title}" (next run {when}).',
  'assist.taskKindOnce': 'Reminder',
  'assist.taskKindRecurring': 'Recurring task',
  'assist.taskHumorNote': ' 😂 with humor',
  'assist.taskCreated':
    '{kind} #{id} "{title}"{humorNote} created. First run: {when} ({tz}). List: /tasks',
  'assist.learnExpenseNothingNew':
    'I already know those words — nothing new added.',
  'assist.learnExpenseDone':
    'Got it: messages with the words {list} now count as expenses. List: /trata',
  'assist.editLexiconDone': 'Done — "{term}" now means "{gloss}". 🤙',
  'assist.editLexiconNotFound':
    'Couldn\'t find "{term}" in the chat\'s slang. Check /slang — it has the exact forms.',
  'assist.poiAdded': 'Added to places: {name}. List: /poi',
  'assist.aiOverloaded':
    '⚠️ The AI is overloaded right now (529). I already retried several times — give it a minute and try again. 🤙',
  'assist.aiError': "⚠️ Couldn't reach the AI. Try again a bit later.",
  'assist.connectSplid':
    "To log expenses in Splid, connect a group: /group <invite-code>. It's optional — I'll help without it too: reminders, search, notes. 🤙",
  'assist.beforeOpenAi': '🔬 Before OpenAI:\n\n{text}',
  'assist.previewInactive': 'This preview is no longer active.',
  'assist.connectSplidReword': 'First connect a Splid group with the /group command.',
  'assist.rewordNotUnderstood':
    'I didn\'t understand the correction. You can rewrite the whole expense, e.g.: «taxi 500 for me and Kolya».',
};
