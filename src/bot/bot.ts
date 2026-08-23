import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { logger } from '../logger.js';
import { authGate } from './middleware/auth.js';
import { cmdStart } from './commands/start.js';
import { cmdHelp } from './commands/help.js';
import { cmdRequest } from './commands/request.js';
import { cmdApprove, cmdDeny, handleUserCallback } from './commands/approve.js';
import { cmdWhitelist, cmdAllow } from './commands/whitelist.js';
import { cmdAdmins, cmdSuperAdmin } from './commands/admins.js';
import { getChatMode, setChatTitle } from '../db/repos/chatSettings.repo.js';
import { modeAllowsReactions } from '../modes.js';
import { cmdGroup } from './commands/group.js';
import { cmdMembers } from './commands/members.js';
import { cmdLink } from './commands/link.js';
import { cmdWhoami } from './commands/whoami.js';
import { cmdMemory, cmdRemember, cmdForget } from './commands/memory.js';
import { cmdTasks, cmdCancelTask, cmdTaskHumor } from './commands/tasks.js';
import { cmdWatch } from './commands/watch.js';
import { cmdPoi, cmdDelPoi } from './commands/poi.js';
import { cmdSlang } from './commands/lexicon.js';
import { cmdRules } from './commands/rules.js';
import { cmdTrata } from './commands/expenseTerm.js';
import { cmdPing } from './commands/ping.js';
import { cmdDota } from './commands/dota.js';
import {
  cmdChats,
  cmdChat,
  cmdSetGroup,
  cmdSetCurrency,
  cmdSetMemory,
  cmdAddMemory,
  cmdPersona,
  cmdDedupeMemory,
  cmdEditMemory,
  cmdReconcile,
  cmdClearMemory,
  cmdSetLink,
  cmdUnlink,
  cmdMode,
  cmdModes,
  cmdTrust,
  cmdChime,
  cmdHumor,
  cmdReact,
  cmdChatLog,
} from './commands/admin.js';
import { onMessage } from './handlers/onMessage.js';
import { onPhoto } from './handlers/onPhoto.js';
import { onDocument } from './handlers/onDocument.js';
import { onVoice } from './handlers/onVoice.js';
import { onBotMembership, handleModeCallback } from './handlers/onBotMembership.js';
import { onForwardReaction } from './handlers/onForwardReaction.js';
import { registerExpiryApi } from './forwardBuffer.js';
import { handleExpenseCallback } from './flows/confirm.js';
import { maybeAutoReact } from './reactions.js';
import { cancelChime } from './flows/chime.js';

export function buildBot(token: string): Bot {
  const bot = new Bot(token);

  // Concurrency ordering: updates are processed concurrently (via @grammyjs/runner
  // in index.ts) so one slow LLM turn no longer blocks every other chat. But within
  // a SINGLE chat order still matters — pending expense previews, edit-target maps,
  // the chime silence timer and the lexicon/memory buffers are all per-chat mutable
  // state, and a correction must not overtake the message it corrects. sequentialize
  // keyed by chat id keeps each chat strictly in order while letting different chats
  // run in parallel. Must be the FIRST middleware so the whole chain is ordered.
  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

  // "Bot was added/removed" onboarding runs BEFORE the auth gate: the person
  // adding the bot to a chat is usually not whitelisted, but the admin must
  // still get the join notification (with the mode picker). The handler only
  // ever DMs the admin, so it's safe in front of the gate.
  bot.on('my_chat_member', onBotMembership);

  // Default-deny gate (lets /start, /help, /request through for everyone).
  bot.use(authGate);

  // Light auto-reactions: with a small probability, drop a random positive
  // reaction on a message. Runs for any message type that passed the gate, then
  // continues the chain so normal routing (commands, expense/chat) still happens.
  bot.on('message', async (ctx, next) => {
    // Any new message (of any type) means the chat is active: cancel a pending
    // spontaneous chime so the bot only ever chimes into a genuine lull.
    if (ctx.chat?.id != null) cancelChime(ctx.chat.id);
    // Keep the chat's display name fresh so /chats shows names, not bare ids
    // (the SQL no-ops when the title hasn't changed).
    if (ctx.chat && 'title' in ctx.chat && ctx.chat.title) {
      setChatTitle(ctx.chat.id, ctx.chat.title);
    }
    // No playful reactions where the mode doesn't want them — a study room and a
    // calm assistant chat are not the group hang.
    if (ctx.chat?.id == null || modeAllowsReactions(getChatMode(ctx.chat.id))) {
      await maybeAutoReact(ctx);
    }
    await next();
  });

  bot.command('start', cmdStart);
  bot.command('help', cmdHelp);
  bot.command('request', cmdRequest);
  bot.command('approve', cmdApprove);
  bot.command('deny', cmdDeny);
  bot.command('whitelist', cmdWhitelist);
  bot.command('allow', cmdAllow);
  bot.command('group', cmdGroup);
  bot.command('members', cmdMembers);
  bot.command('link', cmdLink);
  bot.command('whoami', cmdWhoami);
  bot.command('memory', cmdMemory);
  bot.command('remember', cmdRemember);
  bot.command('forget', cmdForget);
  bot.command('tasks', cmdTasks);
  bot.command('canceltask', cmdCancelTask);
  bot.command('taskhumor', cmdTaskHumor);
  bot.command('watch', cmdWatch);
  bot.command('poi', cmdPoi);
  bot.command('delpoi', cmdDelPoi);
  bot.command('slang', cmdSlang);
  bot.command('rules', cmdRules);
  bot.command('trata', cmdTrata);
  bot.command('ping', cmdPing);

  // Chat administration (private chat with the bot): supreme admins manage every
  // chat, chat admins the chats granted to them via /admins.
  bot.command('admins', cmdAdmins);
  bot.command('superadmin', cmdSuperAdmin);
  bot.command('chats', cmdChats);
  bot.command('chat', cmdChat);
  bot.command('setgroup', cmdSetGroup);
  bot.command('setcurrency', cmdSetCurrency);
  bot.command('setmemory', cmdSetMemory);
  bot.command('addmemory', cmdAddMemory);
  bot.command('persona', cmdPersona);
  bot.command('dedupememory', cmdDedupeMemory);
  bot.command('editmemory', cmdEditMemory);
  bot.command('reconcile', cmdReconcile);
  bot.command('clearmemory', cmdClearMemory);
  bot.command('setlink', cmdSetLink);
  bot.command('unlink', cmdUnlink);
  bot.command('mode', cmdMode);
  bot.command('modes', cmdModes);
  bot.command('trust', cmdTrust);
  bot.command('chime', cmdChime);
  bot.command('humor', cmdHumor);
  bot.command('react', cmdReact);
  bot.command('chatlog', cmdChatLog);
  bot.command('dota', cmdDota);

  bot.callbackQuery(/^u:/, handleUserCallback);
  bot.callbackQuery(/^e:/, handleExpenseCallback);
  bot.callbackQuery(/^m:/, handleModeCallback);

  // Reaction taps: the forward batch's "process now" button. Delivered only
  // because index.ts requests message_reaction in allowed_updates; runs behind
  // the auth gate like everything else.
  bot.on('message_reaction', onForwardReaction);

  bot.on('message:photo', onPhoto);
  bot.on('message:document', onDocument);
  bot.on('message:voice', onVoice);
  bot.on('message:text', onMessage);

  // Let the batch-expiry timer clear its reaction marks (it has no ctx of its own).
  registerExpiryApi(bot.api);

  bot.catch(async (err) => {
    logger.error({ err: err.error, update: err.ctx.update.update_id }, 'bot error');
    // A handler that throws mid-way (e.g. a reply Telegram rejects) would
    // otherwise leave the user staring at silence. For an explicit command,
    // surface that something broke so it's never a silent no-op. Best-effort:
    // if even this reply fails, just swallow it.
    const wasCommand = (err.ctx.message?.text ?? '').startsWith('/');
    if (wasCommand) {
      try {
        await err.ctx.reply('⚠️ Не смог выполнить команду — что-то пошло не так.');
      } catch {
        /* nothing more we can do */
      }
    }
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
  { command: 'forget', description: 'Забыть пункт (/forget N) или очистить всё' },
  { command: 'tasks', description: 'Напоминания и регулярные задачи' },
  { command: 'canceltask', description: 'Отменить задачу по id' },
  { command: 'taskhumor', description: 'Юмор для задачи: /taskhumor <id> on|off' },
  { command: 'watch', description: 'Вотчеры страниц (/watch del <id> — снять)' },
  { command: 'poi', description: 'Список мест (кафе, достопримечательности, планы)' },
  { command: 'delpoi', description: 'Удалить место по id' },
  { command: 'slang', description: 'Словечки, которые я подхватил из чата' },
  { command: 'rules', description: 'Правила поведения в этом чате (/rules add <текст>)' },
  { command: 'trata', description: 'Слова, которые я считаю тратами' },
  { command: 'ping', description: 'Пингануть состав (/ping show — глянуть без пинга)' },
  { command: 'dota', description: 'База по доте: /dota, /dota sync, /dota <название>' },
  { command: 'whoami', description: 'Кто я для бота' },
  { command: 'request', description: 'Запросить доступ' },
];
