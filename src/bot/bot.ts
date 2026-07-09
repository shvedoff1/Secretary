import { Bot } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import { logger } from '../logger.js';
import { t } from '../i18n/index.js';
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
import { cmdTasks, cmdCancelTask, cmdTaskHumor } from './commands/tasks.js';
import { cmdPoi, cmdDelPoi } from './commands/poi.js';
import { cmdSlang } from './commands/lexicon.js';
import { cmdTrata } from './commands/expenseTerm.js';
import { cmdStyle } from './commands/style.js';
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
} from './commands/admin.js';
import { onMessage } from './handlers/onMessage.js';
import { onPhoto } from './handlers/onPhoto.js';
import { onVoice } from './handlers/onVoice.js';
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

  // Default-deny gate (lets /start, /help, /request through for everyone).
  bot.use(authGate);

  // Light auto-reactions: with a small probability, drop a random positive
  // reaction on a message. Runs for any message type that passed the gate, then
  // continues the chain so normal routing (commands, expense/chat) still happens.
  bot.on('message', async (ctx, next) => {
    // Any new message (of any type) means the chat is active: cancel a pending
    // spontaneous chime so the bot only ever chimes into a genuine lull.
    if (ctx.chat?.id != null) cancelChime(ctx.chat.id);
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
  bot.command('taskhumor', cmdTaskHumor);
  bot.command('poi', cmdPoi);
  bot.command('delpoi', cmdDelPoi);
  bot.command('slang', cmdSlang);
  bot.command('trata', cmdTrata);
  bot.command('style', cmdStyle);

  // Admin-only chat administration (private chat with the bot).
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

  bot.callbackQuery(/^u:/, handleUserCallback);
  bot.callbackQuery(/^e:/, handleExpenseCallback);

  bot.on('message:photo', onPhoto);
  bot.on('message:voice', onVoice);
  bot.on('message:text', onMessage);

  bot.catch(async (err) => {
    logger.error({ err: err.error, update: err.ctx.update.update_id }, 'bot error');
    // A handler that throws mid-way (e.g. a reply Telegram rejects) would
    // otherwise leave the user staring at silence. For an explicit command,
    // surface that something broke so it's never a silent no-op. Best-effort:
    // if even this reply fails, just swallow it.
    const wasCommand = (err.ctx.message?.text ?? '').startsWith('/');
    if (wasCommand) {
      try {
        await err.ctx.reply(t('boterr.commandFailed'));
      } catch {
        /* nothing more we can do */
      }
    }
  });

  return bot;
}

// Command menu descriptions are resolved via `t()` at runtime (so they follow
// `BOT_LOCALE`), hence a function rather than a `const` array. Consumed by
// `src/index.ts` (`bot.api.setMyCommands(botCommands())`) at startup.
export function botCommands() {
  return [
    { command: 'help', description: t('cmd.help') },
    { command: 'group', description: t('cmd.group') },
    { command: 'members', description: t('cmd.members') },
    { command: 'link', description: t('cmd.link') },
    { command: 'memory', description: t('cmd.memory') },
    { command: 'remember', description: t('cmd.remember') },
    { command: 'forget', description: t('cmd.forget') },
    { command: 'tasks', description: t('cmd.tasks') },
    { command: 'canceltask', description: t('cmd.canceltask') },
    { command: 'taskhumor', description: t('cmd.taskhumor') },
    { command: 'poi', description: t('cmd.poi') },
    { command: 'delpoi', description: t('cmd.delpoi') },
    { command: 'slang', description: t('cmd.slang') },
    { command: 'trata', description: t('cmd.trata') },
    { command: 'style', description: t('cmd.style') },
    { command: 'whoami', description: t('cmd.whoami') },
    { command: 'request', description: t('cmd.request') },
  ];
}
