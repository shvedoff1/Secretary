import { Bot } from 'grammy';
import { logger } from '../logger.js';
import { authGate } from './middleware/auth.js';
import { cmdStart } from './commands/start.js';
import { cmdHelp } from './commands/help.js';
import { cmdRequest } from './commands/request.js';
import { cmdApprove, cmdDeny, handleUserCallback } from './commands/approve.js';
import { cmdGroup } from './commands/group.js';
import { cmdMembers } from './commands/members.js';
import { cmdLink } from './commands/link.js';
import { cmdWhoami } from './commands/whoami.js';
import { cmdMemory, cmdRemember, cmdForget } from './commands/memory.js';
import { cmdTasks, cmdCancelTask } from './commands/tasks.js';
import { cmdPoi, cmdDelPoi } from './commands/poi.js';
import { cmdSlang } from './commands/lexicon.js';
import {
  cmdChats,
  cmdChat,
  cmdSetGroup,
  cmdSetCurrency,
  cmdSetMemory,
  cmdAddMemory,
  cmdClearMemory,
  cmdSetLink,
  cmdUnlink,
} from './commands/admin.js';
import { onMessage } from './handlers/onMessage.js';
import { onPhoto } from './handlers/onPhoto.js';
import { onVoice } from './handlers/onVoice.js';
import { handleExpenseCallback } from './flows/confirm.js';
import { maybeAutoReact } from './reactions.js';

export function buildBot(token: string): Bot {
  const bot = new Bot(token);

  // Default-deny gate (lets /start, /help, /request through for everyone).
  bot.use(authGate);

  // Light auto-reactions: with a small probability, drop a random positive
  // reaction on a message. Runs for any message type that passed the gate, then
  // continues the chain so normal routing (commands, expense/chat) still happens.
  bot.on('message', async (ctx, next) => {
    await maybeAutoReact(ctx);
    await next();
  });

  bot.command('start', cmdStart);
  bot.command('help', cmdHelp);
  bot.command('request', cmdRequest);
  bot.command('approve', cmdApprove);
  bot.command('deny', cmdDeny);
  bot.command('group', cmdGroup);
  bot.command('members', cmdMembers);
  bot.command('link', cmdLink);
  bot.command('whoami', cmdWhoami);
  bot.command('memory', cmdMemory);
  bot.command('remember', cmdRemember);
  bot.command('forget', cmdForget);
  bot.command('tasks', cmdTasks);
  bot.command('canceltask', cmdCancelTask);
  bot.command('poi', cmdPoi);
  bot.command('delpoi', cmdDelPoi);
  bot.command('slang', cmdSlang);

  // Admin-only chat administration (private chat with the bot).
  bot.command('chats', cmdChats);
  bot.command('chat', cmdChat);
  bot.command('setgroup', cmdSetGroup);
  bot.command('setcurrency', cmdSetCurrency);
  bot.command('setmemory', cmdSetMemory);
  bot.command('addmemory', cmdAddMemory);
  bot.command('clearmemory', cmdClearMemory);
  bot.command('setlink', cmdSetLink);
  bot.command('unlink', cmdUnlink);

  bot.callbackQuery(/^u:/, handleUserCallback);
  bot.callbackQuery(/^e:/, handleExpenseCallback);

  bot.on('message:photo', onPhoto);
  bot.on('message:voice', onVoice);
  bot.on('message:text', onMessage);

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx.update.update_id }, 'bot error');
  });

  return bot;
}

export const BOT_COMMANDS = [
  { command: 'help', description: 'Что я умею' },
  { command: 'group', description: 'Подключить группу Splid' },
  { command: 'members', description: 'Участники группы' },
  { command: 'link', description: 'Привязать аккаунт к участнику Splid' },
  { command: 'memory', description: 'Заметки чата' },
  { command: 'remember', description: 'Добавить заметку' },
  { command: 'forget', description: 'Очистить заметки' },
  { command: 'tasks', description: 'Напоминания и регулярные задачи' },
  { command: 'canceltask', description: 'Отменить задачу по id' },
  { command: 'poi', description: 'Список мест (кафе, достопримечательности, планы)' },
  { command: 'delpoi', description: 'Удалить место по id' },
  { command: 'slang', description: 'Словечки, которые я подхватил из чата' },
  { command: 'whoami', description: 'Кто я для бота' },
  { command: 'request', description: 'Запросить доступ' },
];
