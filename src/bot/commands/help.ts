import type { Context } from 'grammy';
import { isBotManager, isSupremeAdmin } from '../permissions.js';
import { MODE_NAMES } from '../../modes.js';

export async function cmdHelp(ctx: Context): Promise<void> {
  const uid = ctx.from?.id ?? 0;
  const supreme = isSupremeAdmin(uid);
  const manager = isBotManager(uid);

  // Chat admins and supreme admins both manage chats from the DM; the shared
  // section shows the per-chat toolkit. /chats is the entry point — it lists
  // exactly the chats the caller may touch, with tap-to-copy commands.
  const managerSection = manager
    ? [
        '',
        supreme ? 'Управление чатами (в личке):' : 'Твои чаты (ты — админ чата; всё в личке):',
        '/chats — список твоих чатов с готовыми командами (копируются тапом)',
        '/chat <chatId> — настройки чата: пресет, доступ, память, сленг, правила',
        `/modes — пресеты характера; /mode <chatId> — сменить кнопками (или /mode <chatId> ${MODE_NAMES})`,
        '/prompt <chatId> <текст> — свой характер бота своими словами (пресет «кастом»)',
        '/setup <chatId> — карта поведения: что такое юморайзер, сленг, вбросы и реакции и как их переключать',
        '/rules <chatId> [add <текст>|del <N>|clear] — правила поведения для чата',
        '/trust <chatId> on|off — открыть/закрыть доступ участникам чата',
        '/chime <chatId> on|off — рандомные вбросы бота в тишину',
        '/humor <chatId> on|off — юморайзер (OpenAI-переписывание ответов)',
        '/slang <chatId> on|off — говорить словечками чата (факты не меняются)',
        '/react <chatId> on|off — рандомные реакции-эмодзи',
        '/chatlog <chatId> — лог сообщений чата; /chatlog <chatId> clear — очистить',
        '/episodes <chatId> — журнал бесед (эпизодическая память); /episodes <chatId> clear — очистить',
        '/profile <chatId> — карточки профилей чата и людей; /profile <chatId> clear — стереть (пересоберутся)',
        '/setgroup <id> <код> · /setcurrency <id> <CUR> — Splid и валюта',
        '/setmemory <id> <текст> · /addmemory <id> <текст> · /clearmemory <id> — память',
        '/setlink <id> <tgUserId> <имя> · /unlink <id> <tgUserId> — привязки к Splid',
      ]
    : [];

  // Bot-wide powers: only supreme admins manage people (whitelist and roles).
  const supremeSection = supreme
    ? [
        '',
        'Верховный админ (люди и роли):',
        '/whitelist — кто имеет доступ; /allow <id> [имя] — открыть; /deny <id> — закрыть',
        '/admins <chatId> [add <tgUserId> [имя]|del <tgUserId>] — админы чата (у них все команды выше для этого чата)',
        '/superadmin [add <tgUserId> [имя]|del <tgUserId>] — верховные админы (передать права)',
      ]
    : [];

  await ctx.reply(
    [
      'Что я умею:',
      '• Записывать траты: просто напишите «потратил 500 за такси за меня и Колю», пришлите голосовое или фото чека — я покажу превью с кнопками ✅/✏️/❌.',
      '• Отвечать на вопросы (в группе — если упомянуть меня @ или ответить на моё сообщение).',
      '• Напоминать и выполнять регулярные задачи: напиши «напомни завтра в 9 купить молоко» или «каждое утро ищи прогноз волн и кидай сюда».',
      '• Хранить места: скажи «запиши это кафе, отличный кофе» или «добавь в места — смотровая, хочу сходить». Список с ссылками на Google Maps — /poi.',
      '• Слушаться правил чата: скажи «с этого момента все голосовые очищай от слов-паразитов и скидывай расшифровку» или «отвечай короче» — запомню как правило и буду соблюдать во всех ответах (список — /rules).',
      '• Пересказывать чат: спроси «перескажи, что было в последних 200 сообщениях», «что я пропустил» или «о чём болтали вчера» — соберу выжимку из того, что тут писали.',
      '• Следить за страницей до события: «следи за https://… и напиши, когда появятся сеансы Титана» — я буду проверять сам и напишу, как появится.',
      '',
      'Команды:',
      '/group <код> — подключить группу Splid (по коду-приглашению)',
      '/members — участники группы и их привязки',
      '/link [в ответ на сообщение] <имя|инициалы> — привязать Telegram-аккаунт к участнику Splid',
      '/memory — показать заметки чата',
      '/remember <текст> — добавить заметку',
      '/forget — очистить заметки',
      '/tasks — список напоминаний и регулярных задач',
      '/canceltask <id> — отменить задачу',
      '/taskhumor <id> on|off — включить/выключить юмор для задачи',
      '/watch — вотчеры страниц; /watch del <id> — снять; /watch check <id> — проверить сейчас',
      '/flight — слежки за рейсами (создаются словами: «следи за рейсом K6829, напиши если отменят»); /flight del <id> — снять; /flight check <id> — проверить сейчас',
      '/poi — список мест (кафе, достопримечательности, планы) с ссылками на карту',
      '/delpoi <id> — удалить место',
      '/ping — пингануть состав; /ping <список> — другой список; /ping show — состав без пинга; редактировать: /ping add|del [список] @ник … или просто скажи «добавь @ника в пинг»',
      '/slang — словечки, которые я подхватил из чата (/slang on|off — говорить ими или нет, /slang clear — сбросить)',
      '/rules — правила поведения в этом чате: /rules add <текст> — задать, /rules del <N> — убрать, /rules clear — очистить',
      '/trata — слова, которые я считаю тратами (ответь «запомни, это трата» на пропущенное сообщение)',
      '/whoami — кто я для бота (и мой id для админских команд)',
      '/request — запросить доступ',
      ...managerSection,
      ...supremeSection,
    ].join('\n'),
  );
}
