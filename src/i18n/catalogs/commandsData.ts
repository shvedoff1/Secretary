// i18n catalog: commandsData namespace. Populated by the i18n migration.
// The 'en' half is typed against the 'ru' key set so every key must be translated.
export const commandsDataRu = {
  // memory.ts
  'memory.empty': 'Память чата пуста. Добавьте: /remember <текст>',
  'memory.list':
    '🧠 Память чата:\n{body}\n\n📌 — закреплено (не забывается), 🎭 — стиль/повадки. Забыть один пункт: /forget <номер>. Стереть всё (и историю диалога): /forget',
  'memory.remember.usage': 'Использование: /remember <что запомнить>',
  'memory.forget.usage':
    'Использование: /forget <номер пункта из /memory> — или /forget без номера, чтобы стереть всё.',
  'memory.forget.noItem': 'Нет пункта №{n}. Посмотреть список: /memory',
  'memory.forget.removed': '🧹 Забыл: {item}',
  'memory.forget.cleared': '🧹 Память и история диалога очищены.',

  // tasks.ts
  'tasks.none':
    'Активных напоминаний нет. Напиши, например: «каждое утро в 8 ищи прогноз волн и кидай сюда».',
  'tasks.line': '{kind}{humor} #{id} «{title}» — следующий запуск {when} ({timezone})',
  'tasks.list.header': '⏰ Напоминания и задачи:',
  'tasks.list.cancelHint': 'Отменить: /canceltask <id>',
  'tasks.list.humorHint': 'Юмор: /taskhumor <id> on|off',
  'tasks.humor.usage': 'Использование: /taskhumor <id> on|off (id смотри в /tasks)',
  'tasks.humor.notFound': 'Не нашёл активную задачу #{id} в этом чате.',
  'tasks.humor.on': '😂 Юмор включён для задачи #{id}.',
  'tasks.humor.off': 'Юмор выключен для задачи #{id}.',
  'tasks.cancel.usage': 'Использование: /canceltask <id> (id смотри в /tasks)',
  'tasks.cancel.deleted': '🗑 Задача #{id} удалена.',
  'tasks.cancel.notFound': 'Не нашёл задачу #{id} в этом чате.',

  // poi.ts
  'poi.empty':
    'Список мест пуст. Скажи, например: «запиши это кафе, отличный кофе» или «добавь в места — смотровая площадка, хочу сходить» — и я сохраню точку с ссылкой на карту.',
  'poi.del.usage': 'Использование: /delpoi <id> (id смотри в /poi)',
  'poi.del.deleted': '🗑 Точка #{id} удалена.',
  'poi.del.notFound': 'Не нашёл точку #{id} в этом чате.',

  // lexicon.ts
  'slang.adminOnly': 'Чужой чат по id смотрит только администратор.',
  'slang.cleared.other': '🧹 Сленг чата {chatId} очищен.',
  'slang.cleared.self': '🧹 Выученный сленг очищен.',
  'slang.empty.other': 'У чата {chatId} пока нет выученных словечек.',
  'slang.empty.self':
    'Пока не набрал ваших словечек — поболтайте, со временем подхвачу. (Сброс: /slang clear)',
  'slang.list.header.other': '🗣️ Словечки чата {chatId}:',
  'slang.list.header.self': '🗣️ Словечки чата:',
  'slang.list.footer.other': 'Сброс: /slang {chatId} clear',
  'slang.list.footer.self': 'Сброс: /slang clear',

  // expenseTerm.ts
  'trata.cleared': '🧹 Выученный словарь трат очищен.',
  'trata.nothingNew': 'Уже знаю такие слова — ничего нового не добавил.',
  'trata.added': '✍️ Добавил в словарь трат: {list}.',
  'trata.empty':
    'Словарь трат пуст. Ответь на сообщение, которое я пропустил, и напиши «запомни, это трата» — или добавь словом: /trata дошик, на бензин. (Сброс: /trata clear)',
  'trata.list':
    '💸 Слова, которые я считаю тратами:\n{list}\n\nДобавить: /trata <слово>. Сброс: /trata clear',

  // style.ts
  'style.list':
    '🎭 Стиль общения в этом чате: <b>{currentId}</b>\n\n{list}\n\nСменить: <code>/style &lt;id&gt;</code> (напр. <code>/style chill</code>).',
  'style.notFound': 'Нет такого стиля «{arg}». Доступные: {ids}. Список: /style',
  'style.set': '🎭 Стиль чата: <b>{name}</b> ({id}). {description}',
} as const;

export const commandsDataEn: Record<keyof typeof commandsDataRu, string> = {
  // memory.ts
  'memory.empty': 'Chat memory is empty. Add one: /remember <text>',
  'memory.list':
    '🧠 Chat memory:\n{body}\n\n📌 — pinned (never forgotten), 🎭 — style/manner. Forget one item: /forget <number>. Wipe everything (and dialogue history): /forget',
  'memory.remember.usage': 'Usage: /remember <what to remember>',
  'memory.forget.usage':
    'Usage: /forget <item number from /memory> — or /forget with no number to wipe everything.',
  'memory.forget.noItem': 'No item #{n}. See the list: /memory',
  'memory.forget.removed': '🧹 Forgot: {item}',
  'memory.forget.cleared': '🧹 Memory and dialogue history cleared.',

  // tasks.ts
  'tasks.none':
    'No active reminders. Write, for example: "every morning at 8 look up the wave forecast and post it here".',
  'tasks.line': '{kind}{humor} #{id} "{title}" — next run {when} ({timezone})',
  'tasks.list.header': '⏰ Reminders and tasks:',
  'tasks.list.cancelHint': 'Cancel: /canceltask <id>',
  'tasks.list.humorHint': 'Humor: /taskhumor <id> on|off',
  'tasks.humor.usage': 'Usage: /taskhumor <id> on|off (find the id in /tasks)',
  'tasks.humor.notFound': "Couldn't find an active task #{id} in this chat.",
  'tasks.humor.on': '😂 Humor enabled for task #{id}.',
  'tasks.humor.off': 'Humor disabled for task #{id}.',
  'tasks.cancel.usage': 'Usage: /canceltask <id> (find the id in /tasks)',
  'tasks.cancel.deleted': '🗑 Task #{id} deleted.',
  'tasks.cancel.notFound': "Couldn't find task #{id} in this chat.",

  // poi.ts
  'poi.empty':
    'The places list is empty. Say, for example: "note this café, great coffee" or "add to places — viewpoint, want to visit" — and I\'ll save the point with a map link.',
  'poi.del.usage': 'Usage: /delpoi <id> (find the id in /poi)',
  'poi.del.deleted': '🗑 Point #{id} deleted.',
  'poi.del.notFound': "Couldn't find point #{id} in this chat.",

  // lexicon.ts
  'slang.adminOnly': 'Only an administrator can view another chat by id.',
  'slang.cleared.other': '🧹 Slang for chat {chatId} cleared.',
  'slang.cleared.self': '🧹 Learned slang cleared.',
  'slang.empty.other': 'Chat {chatId} has no learned words yet.',
  'slang.empty.self':
    "Haven't picked up your words yet — chat a bit and I'll catch on over time. (Reset: /slang clear)",
  'slang.list.header.other': '🗣️ Words of chat {chatId}:',
  'slang.list.header.self': "🗣️ Chat's words:",
  'slang.list.footer.other': 'Reset: /slang {chatId} clear',
  'slang.list.footer.self': 'Reset: /slang clear',

  // expenseTerm.ts
  'trata.cleared': '🧹 Learned expense dictionary cleared.',
  'trata.nothingNew': 'I already know those words — nothing new added.',
  'trata.added': '✍️ Added to the expense dictionary: {list}.',
  'trata.empty':
    'The expense dictionary is empty. Reply to a message I missed and write "remember, this is an expense" — or add by word: /trata noodles, on gas. (Reset: /trata clear)',
  'trata.list':
    '💸 Words I treat as expenses:\n{list}\n\nAdd: /trata <word>. Reset: /trata clear',

  // style.ts
  'style.list':
    '🎭 Chat conversation style: <b>{currentId}</b>\n\n{list}\n\nChange: <code>/style &lt;id&gt;</code> (e.g. <code>/style chill</code>).',
  'style.notFound': 'No such style "{arg}". Available: {ids}. List: /style',
  'style.set': '🎭 Chat style: <b>{name}</b> ({id}). {description}',
};
