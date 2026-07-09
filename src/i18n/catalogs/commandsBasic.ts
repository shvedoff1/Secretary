// i18n catalog: commandsBasic namespace. Populated by the i18n migration.
// The 'en' half is typed against the 'ru' key set so every key must be translated.
export const commandsBasicRu = {
  // start.ts
  'start.greeting': 'Привет! Я Secretary 🤝',
  'start.intro': 'Записываю общие траты в Splid и помогаю в чате (вопросы, заметки).',
  'start.status': 'Ваш статус доступа: {status}.',
  'start.ready': 'Готов к работе — наберите /help.',
  'start.needRequest': 'Отправьте /request, чтобы запросить доступ у администратора.',
  // Fallback access status when the user has never run /request (used by /start and /whoami).
  'common.notRequested': 'не запрошен',

  // help.ts
  'help.canDo': 'Что я умею:',
  'help.featExpenses':
    '• Записывать траты: просто напишите «потратил 500 за такси за меня и Колю», пришлите голосовое или фото чека — я покажу превью с кнопками ✅/✏️/❌.',
  'help.featQuestions':
    '• Отвечать на вопросы (в группе — если упомянуть меня @ или ответить на моё сообщение).',
  'help.featReminders':
    '• Напоминать и выполнять регулярные задачи: напиши «напомни завтра в 9 купить молоко» или «каждое утро ищи прогноз волн и кидай сюда».',
  'help.featPlaces':
    '• Хранить места: скажи «запиши это кафе, отличный кофе» или «добавь в места — смотровая, хочу сходить». Список с ссылками на Google Maps — /poi.',
  'help.commandsTitle': 'Команды:',
  'help.cmdGroup': '/group <код> — подключить группу Splid (по коду-приглашению)',
  'help.cmdMembers': '/members — участники группы и их привязки',
  'help.cmdLink':
    '/link [в ответ на сообщение] <имя|инициалы> — привязать Telegram-аккаунт к участнику Splid',
  'help.cmdMemory': '/memory — показать заметки чата',
  'help.cmdRemember': '/remember <текст> — добавить заметку',
  'help.cmdForget': '/forget — очистить заметки',
  'help.cmdTasks': '/tasks — список напоминаний и регулярных задач',
  'help.cmdCanceltask': '/canceltask <id> — отменить задачу',
  'help.cmdTaskhumor': '/taskhumor <id> on|off — включить/выключить юмор для задачи',
  'help.cmdPoi': '/poi — список мест (кафе, достопримечательности, планы) с ссылками на карту',
  'help.cmdDelpoi': '/delpoi <id> — удалить место',
  'help.cmdStyle': '/style — стиль общения в чате (/style <id> — выбрать: neutral, chill, formal)',
  'help.cmdSlang': '/slang — словечки, которые я подхватил из чата (/slang clear — сбросить)',
  'help.cmdTrata':
    '/trata — слова, которые я считаю тратами (ответь «запомни, это трата» на пропущенное сообщение)',
  'help.cmdWhoami': '/whoami — кто я для бота',
  'help.cmdRequest': '/request — запросить доступ',
  'help.adminTitle': 'Админ (в личке):',
  'help.adminChats': '/chats — список чатов; /chat <id> — детали',
  'help.adminSetgroup': '/setgroup <id> <код> · /setcurrency <id> <CUR>',
  'help.adminSetmemory':
    '/setmemory <id> <текст> · /addmemory <id> <текст> · /clearmemory <id>',
  'help.adminSetlink': '/setlink <id> <tgUserId> <имя> · /unlink <id> <tgUserId>',

  // request.ts
  'request.alreadyHave': 'У вас уже есть доступ.',
  'request.sent': 'Запрос отправлен администратору. Ожидайте одобрения.',
  'request.adminNotice': 'Запрос доступа:\n{name} {username}\nid: {id}',

  // approve.ts
  'approve.adminOnly': 'Только администратор может это делать.',
  'approve.usage': 'Использование: /approve <telegram_id> или /deny <telegram_id>',
  'approve.done': 'Готово: пользователь {id} → {status}.',
  'approve.adminOnlyShort': 'Только администратор.',
  'approve.cbApproved': 'Одобрено',
  'approve.cbDenied': 'Отклонено',
  'approve.editApproved': '✅ Одобрен: {label} ({id})',
  'approve.editDenied': '❌ Отклонён: {label} ({id})',
  'approve.granted': '✅ Доступ открыт! Наберите /help.',
  'approve.denied': '❌ В доступе отказано.',

  // whoami.ts
  'whoami.id': 'id: {id}',
  'whoami.username': 'username: {username}',
  'whoami.role': 'роль: {role}',
  'whoami.status': 'статус: {status}',
  'whoami.mapping': 'привязка в этом чате: {mapping}',

  // group.ts
  'group.usage': 'Использование: /group <код-приглашения Splid>',
  'group.connectFailed': 'Не удалось подключиться к Splid: {msg}',
  'group.connected':
    '✅ Подключено к группе Splid ({count} участников).\nДальше: /members и /link, чтобы связать Telegram-аккаунты с участниками.',

  // members.ts
  'members.noGroup': 'Группа не подключена. Используйте /group <код>.',
  'members.loadFailed': 'Не удалось загрузить участников из Splid.',
  'members.memberLinked': '• {label} ↔ {link}',
  'members.memberUnlinked': '• {label} — не привязан',
  'members.header': 'Участники Splid ({count}):',
  'members.linkHint':
    'Привязать: /link <имя|инициалы> (себя) или в ответ на сообщение участника.',

  // link.ts
  'link.noGroup': 'Группа не подключена. Используйте /group <код>.',
  'link.adminOnly': 'Привязывать других может только администратор.',
  'link.usage':
    'Использование: /link <имя или инициалы участника Splid>\n(в ответ на сообщение — привяжет того пользователя)',
  'link.loadFailed': 'Не удалось загрузить участников из Splid.',
  'link.notFound': 'Не нашёл участника «{query}» в Splid. Список: /members',
  'link.you': 'вас',
  'link.linked': '🔗 Связал {who} ↔ {name}.',
} as const;

export const commandsBasicEn: Record<keyof typeof commandsBasicRu, string> = {
  // start.ts
  'start.greeting': 'Hi! I am Secretary 🤝',
  'start.intro': 'I record shared expenses in Splid and help in the chat (questions, notes).',
  'start.status': 'Your access status: {status}.',
  'start.ready': 'Ready to go — type /help.',
  'start.needRequest': 'Send /request to ask the administrator for access.',
  'common.notRequested': 'not requested',

  // help.ts
  'help.canDo': 'What I can do:',
  'help.featExpenses':
    '• Record expenses: just write "spent 500 on a taxi for me and Kolya", send a voice message or a photo of a receipt — I will show a preview with ✅/✏️/❌ buttons.',
  'help.featQuestions':
    '• Answer questions (in a group — if you mention me @ or reply to my message).',
  'help.featReminders':
    '• Remind and run recurring tasks: write "remind me tomorrow at 9 to buy milk" or "every morning look up the wave forecast and post it here".',
  'help.featPlaces':
    '• Store places: say "note down this cafe, great coffee" or "add to places — viewpoint, want to visit". A list with Google Maps links — /poi.',
  'help.commandsTitle': 'Commands:',
  'help.cmdGroup': '/group <code> — connect a Splid group (by invite code)',
  'help.cmdMembers': '/members — group members and their links',
  'help.cmdLink':
    '/link [in reply to a message] <name|initials> — link a Telegram account to a Splid member',
  'help.cmdMemory': '/memory — show the chat notes',
  'help.cmdRemember': '/remember <text> — add a note',
  'help.cmdForget': '/forget — clear the notes',
  'help.cmdTasks': '/tasks — list of reminders and recurring tasks',
  'help.cmdCanceltask': '/canceltask <id> — cancel a task',
  'help.cmdTaskhumor': '/taskhumor <id> on|off — enable/disable humor for a task',
  'help.cmdPoi': '/poi — list of places (cafes, sights, plans) with map links',
  'help.cmdDelpoi': '/delpoi <id> — remove a place',
  'help.cmdStyle': '/style — chat conversation style (/style <id> — choose: neutral, chill, formal)',
  'help.cmdSlang': '/slang — words I picked up from the chat (/slang clear — reset)',
  'help.cmdTrata':
    '/trata — words I treat as expenses (reply "remember, this is an expense" to a missed message)',
  'help.cmdWhoami': '/whoami — who I am to the bot',
  'help.cmdRequest': '/request — request access',
  'help.adminTitle': 'Admin (in DM):',
  'help.adminChats': '/chats — list of chats; /chat <id> — details',
  'help.adminSetgroup': '/setgroup <id> <code> · /setcurrency <id> <CUR>',
  'help.adminSetmemory':
    '/setmemory <id> <text> · /addmemory <id> <text> · /clearmemory <id>',
  'help.adminSetlink': '/setlink <id> <tgUserId> <name> · /unlink <id> <tgUserId>',

  // request.ts
  'request.alreadyHave': 'You already have access.',
  'request.sent': 'Request sent to the administrator. Please wait for approval.',
  'request.adminNotice': 'Access request:\n{name} {username}\nid: {id}',

  // approve.ts
  'approve.adminOnly': 'Only the administrator can do this.',
  'approve.usage': 'Usage: /approve <telegram_id> or /deny <telegram_id>',
  'approve.done': 'Done: user {id} → {status}.',
  'approve.adminOnlyShort': 'Administrator only.',
  'approve.cbApproved': 'Approved',
  'approve.cbDenied': 'Denied',
  'approve.editApproved': '✅ Approved: {label} ({id})',
  'approve.editDenied': '❌ Denied: {label} ({id})',
  'approve.granted': '✅ Access granted! Type /help.',
  'approve.denied': '❌ Access denied.',

  // whoami.ts
  'whoami.id': 'id: {id}',
  'whoami.username': 'username: {username}',
  'whoami.role': 'role: {role}',
  'whoami.status': 'status: {status}',
  'whoami.mapping': 'link in this chat: {mapping}',

  // group.ts
  'group.usage': 'Usage: /group <Splid invite code>',
  'group.connectFailed': 'Could not connect to Splid: {msg}',
  'group.connected':
    '✅ Connected to the Splid group ({count} members).\nNext: /members and /link to link Telegram accounts with members.',

  // members.ts
  'members.noGroup': 'Group is not connected. Use /group <code>.',
  'members.loadFailed': 'Could not load members from Splid.',
  'members.memberLinked': '• {label} ↔ {link}',
  'members.memberUnlinked': '• {label} — not linked',
  'members.header': 'Splid members ({count}):',
  'members.linkHint':
    'Link: /link <name|initials> (yourself) or in reply to a member\'s message.',

  // link.ts
  'link.noGroup': 'Group is not connected. Use /group <code>.',
  'link.adminOnly': 'Only the administrator can link others.',
  'link.usage':
    'Usage: /link <name or initials of a Splid member>\n(in reply to a message — will link that user)',
  'link.loadFailed': 'Could not load members from Splid.',
  'link.notFound': 'Could not find member "{query}" in Splid. List: /members',
  'link.you': 'you',
  'link.linked': '🔗 Linked {who} ↔ {name}.',
};
