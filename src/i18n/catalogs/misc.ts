// i18n catalog: misc namespace. Populated by the i18n migration.
// The 'en' half is typed against the 'ru' key set so every key must be translated.
export const miscRu = {
  // cmd.* — bot command menu descriptions (bot.ts botCommands()).
  'cmd.help': 'Что я умею',
  'cmd.group': 'Подключить группу Splid',
  'cmd.members': 'Участники группы',
  'cmd.link': 'Привязать аккаунт к участнику Splid',
  'cmd.memory': 'Заметки чата',
  'cmd.remember': 'Добавить заметку',
  'cmd.forget': 'Забыть пункт (/forget N) или очистить всё',
  'cmd.tasks': 'Напоминания и регулярные задачи',
  'cmd.canceltask': 'Отменить задачу по id',
  'cmd.taskhumor': 'Юмор для задачи: /taskhumor <id> on|off',
  'cmd.poi': 'Список мест (кафе, достопримечательности, планы)',
  'cmd.delpoi': 'Удалить место по id',
  'cmd.slang': 'Словечки, которые я подхватил из чата',
  'cmd.trata': 'Слова, которые я считаю тратами',
  'cmd.style': 'Стиль общения: /style или /style <id>',
  'cmd.whoami': 'Кто я для бота',
  'cmd.request': 'Запросить доступ',

  // boterr.* — bot.ts catch handler.
  'boterr.commandFailed': '⚠️ Не смог выполнить команду — что-то пошло не так.',

  // spending.* — spending report output (handler.ts + report.ts).
  'spending.noGroup': 'Группа Splid не подключена — нечего считать. Подключите: /group <код>.',
  'spending.periodWithFilter': '{label} на «{filterLabel}»',
  'spending.reportFailed': 'Не удалось собрать отчёт — Splid не ответил. Попробуйте чуть позже.',
  'spending.nothingSpent': 'За {periodLabel} никто ничего не потратил — кошельки целы.',
  'spending.spendingHeader': '💸 Траты за {periodLabel}',
  'spending.total': 'Всего: {totals} ({count} {plural})',
  'spending.expenseOne': 'трата',
  'spending.expenseFew': 'траты',
  'spending.expenseMany': 'трат',
  'spending.paidBy': 'Платили:',
  'spending.someone': 'кто-то',
  'spending.untitled': 'без названия',
  'spending.largest': 'Крупнейшая: «{title}» — {amount}',
  'spending.allSettled': 'Все в расчёте — никто никому не должен 🎉',
  'spending.whoOwes': '💰 Кто кому должен:',

  // surf.* — surf forecast handler (index.ts).
  'surf.fetchFailed': 'Не получилось достать прогноз волн — попробуй ещё раз чуть позже.',

  // sched.* — scheduler user-facing output.
  'sched.beforeOpenAI': '🔬 До OpenAI (⏰ {title}):\n\n{original}',
  'sched.taskTitlePrefix': '⏰ {title}\n',
} as const;

export const miscEn: Record<keyof typeof miscRu, string> = {
  'cmd.help': 'What I can do',
  'cmd.group': 'Connect a Splid group',
  'cmd.members': 'Group members',
  'cmd.link': 'Link account to a Splid member',
  'cmd.memory': 'Chat notes',
  'cmd.remember': 'Add a note',
  'cmd.forget': 'Forget an item (/forget N) or clear everything',
  'cmd.tasks': 'Reminders and recurring tasks',
  'cmd.canceltask': 'Cancel a task by id',
  'cmd.taskhumor': 'Humor for a task: /taskhumor <id> on|off',
  'cmd.poi': 'List of places (cafes, sights, plans)',
  'cmd.delpoi': 'Delete a place by id',
  'cmd.slang': 'Words I picked up from the chat',
  'cmd.trata': 'Words I treat as expenses',
  'cmd.style': 'Chat style: /style or /style <id>',
  'cmd.whoami': 'Who I am to the bot',
  'cmd.request': 'Request access',

  'boterr.commandFailed': '⚠️ Could not run the command — something went wrong.',

  'spending.noGroup': 'No Splid group connected — nothing to count. Connect one: /group <code>.',
  'spending.periodWithFilter': '{label} on "{filterLabel}"',
  'spending.reportFailed': 'Could not build the report — Splid did not respond. Try again a bit later.',
  'spending.nothingSpent': 'Nobody spent anything for {periodLabel} — wallets intact.',
  'spending.spendingHeader': '💸 Spending for {periodLabel}',
  'spending.total': 'Total: {totals} ({count} {plural})',
  'spending.expenseOne': 'expense',
  'spending.expenseFew': 'expenses',
  'spending.expenseMany': 'expenses',
  'spending.paidBy': 'Paid by:',
  'spending.someone': 'someone',
  'spending.untitled': 'untitled',
  'spending.largest': 'Largest: "{title}" — {amount}',
  'spending.allSettled': 'Everyone is settled up — nobody owes anyone 🎉',
  'spending.whoOwes': '💰 Who owes whom:',

  'surf.fetchFailed': 'Could not fetch the wave forecast — try again a bit later.',

  'sched.beforeOpenAI': '🔬 Before OpenAI (⏰ {title}):\n\n{original}',
  'sched.taskTitlePrefix': '⏰ {title}\n',
};
