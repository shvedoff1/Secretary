import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import {
  listSupremeAdmins,
  setSupremeAdmin,
  upsertStatus,
} from '../../db/repos/users.repo.js';
import {
  addChatAdmin,
  listChatAdmins,
  removeChatAdmin,
} from '../../db/repos/chatAdmin.repo.js';
import { canManageChat, chatLabel, isSupremeAdmin, userLabel } from '../permissions.js';
import { escapeHtml } from '../../util/telegramHtml.js';

// Role management: /admins grants per-chat admin rights ("админ чата" — every
// per-chat capability for that chat), /superadmin grants the bot-wide supreme
// role ("верховный админ" — every chat, the whitelist, and these two commands).
// Both are supreme-only: the hierarchy is deliberately flat — chat admins manage
// chats, only supreme admins manage PEOPLE.

/** Supreme-only, DM-only (role changes are not group content). */
async function ensureSupremeDM(ctx: Context): Promise<boolean> {
  if (!ctx.from || !isSupremeAdmin(ctx.from.id)) {
    if (ctx.chat?.type === 'private') {
      await ctx.reply('Назначать админов может только верховный админ.');
    }
    return false;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Команды по ролям работают только в личке со мной.');
    return false;
  }
  return true;
}

function code(cmd: string): string {
  return `<code>${escapeHtml(cmd)}</code>`;
}

/** Split "<head> <rest...>" on the first whitespace. */
function headTail(s: string): [string, string] {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s.trim());
  return m ? [m[1]!, m[2]!.trim()] : ['', ''];
}

function parseUserId(token: string): number | null {
  const id = Number(token);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * `/admins <chatId>` — who administers the chat;
 * `/admins <chatId> add <tgUserId> [имя]` — grant chat-admin rights (also
 * whitelists the user, so their DM with the bot works right away);
 * `/admins <chatId> del <tgUserId>` — revoke them.
 */
export async function cmdAdmins(ctx: Context): Promise<void> {
  if (!(await ensureSupremeDM(ctx))) return;
  const raw = ((ctx.match as string | undefined) ?? '').trim();
  const [idTok, rest] = headTail(raw);
  const chatId = Number(idTok);
  if (!idTok || !Number.isInteger(chatId) || chatId === 0) {
    await ctx.reply(
      'Использование: /admins <chatId> — кто админит чат;\n' +
        '/admins <chatId> add <tgUserId> [имя] — выдать права на чат;\n' +
        '/admins <chatId> del <tgUserId> — забрать.\n' +
        'Ids чатов — в /chats, id человека — в /whitelist (или пусть напишет /whoami).',
    );
    return;
  }

  const [verb, restB] = headTail(rest);
  const action = verb.toLowerCase();

  if (action === 'add' || action === 'del') {
    const [uidTok, name] = headTail(restB);
    const uid = parseUserId(uidTok);
    if (uid === null) {
      await ctx.reply(`Использование: /admins ${chatId} ${action} <tgUserId>${action === 'add' ? ' [имя]' : ''}`);
      return;
    }
    if (action === 'add') {
      // Rights without access are useless: the default-deny gate would still
      // block the new admin's DM, so the grant whitelists them too.
      upsertStatus(uid, 'approved', ctx.from!.id, name || null);
      addChatAdmin(chatId, uid, ctx.from!.id);
      await ctx.reply(
        `✅ ${name || userLabel(uid)} (id ${uid}) теперь админ чата «${chatLabel(chatId)}» — ` +
          `может настраивать его из лички со мной (/chats, /chat ${chatId}).`,
      );
      // Best-effort heads-up; fails silently when they haven't started the bot yet.
      try {
        await ctx.api.sendMessage(
          uid,
          `👑 Тебе выдали права админа чата «${chatLabel(chatId)}». ` +
            `Набери /chats — покажу, что с ним можно делать.`,
        );
      } catch (err) {
        logger.debug({ err, uid }, 'could not notify new chat admin');
      }
      return;
    }
    const removed = removeChatAdmin(chatId, uid);
    await ctx.reply(
      removed
        ? `🚫 ${userLabel(uid)} (id ${uid}) больше не админ чата «${chatLabel(chatId)}».`
        : `${userLabel(uid)} (id ${uid}) и так не админ чата ${chatId}.`,
    );
    return;
  }

  if (action) {
    await ctx.reply(`Не понял «${verb}». Использование: /admins <chatId> [add <tgUserId> [имя]|del <tgUserId>]`);
    return;
  }

  const admins = listChatAdmins(chatId);
  const lines = admins.length
    ? admins.map((a) => `• ${escapeHtml(userLabel(a.tg_user_id))} — id <code>${a.tg_user_id}</code>`)
    : ['(только верховные админы)'];
  await ctx.reply(
    [
      `Админы чата «${escapeHtml(chatLabel(chatId))}»:`,
      ...lines,
      '',
      `Выдать: ${code(`/admins ${chatId} add <tgUserId> [имя]`)}`,
      `Забрать: ${code(`/admins ${chatId} del <tgUserId>`)}`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}

/**
 * `/superadmin` — list supreme admins;
 * `/superadmin add <tgUserId> [имя]` — hand the supreme role to someone else
 * (they get everything, including the right to appoint admins — this is how
 * rights are transferred);
 * `/superadmin del <tgUserId>` — take it back. The configured
 * ADMIN_TELEGRAM_ID is the root owner: it can't be demoted (and is re-ensured
 * on every startup anyway), so the owner always keeps rights over all chats.
 */
export async function cmdSuperAdmin(ctx: Context): Promise<void> {
  if (!(await ensureSupremeDM(ctx))) return;
  const rootId = loadConfig().ADMIN_TELEGRAM_ID;
  const raw = ((ctx.match as string | undefined) ?? '').trim();
  const [verb, rest] = headTail(raw);
  const action = verb.toLowerCase();

  if (action === 'add' || action === 'del') {
    const [uidTok, name] = headTail(rest);
    const uid = parseUserId(uidTok);
    if (uid === null) {
      await ctx.reply(`Использование: /superadmin ${action} <tgUserId>${action === 'add' ? ' [имя]' : ''}`);
      return;
    }
    if (action === 'add') {
      setSupremeAdmin(uid, true, ctx.from!.id, name || null);
      await ctx.reply(
        `👑 ${name || userLabel(uid)} (id ${uid}) теперь верховный админ: все чаты, вайтлист, назначение админов.`,
      );
      try {
        await ctx.api.sendMessage(
          uid,
          '👑 Тебе выдали права верховного админа бота. Набери /help — там всё, что теперь можно.',
        );
      } catch (err) {
        logger.debug({ err, uid }, 'could not notify new supreme admin');
      }
      return;
    }
    if (uid === rootId) {
      await ctx.reply('Это корневой админ из конфига бота — его разжаловать нельзя.');
      return;
    }
    setSupremeAdmin(uid, false, ctx.from!.id);
    await ctx.reply(`🚫 ${userLabel(uid)} (id ${uid}) больше не верховный админ (доступ к боту остался).`);
    return;
  }

  if (action) {
    await ctx.reply(`Не понял «${verb}». Использование: /superadmin [add <tgUserId> [имя]|del <tgUserId>]`);
    return;
  }

  const admins = listSupremeAdmins();
  await ctx.reply(
    [
      `Верховные админы (${admins.length}):`,
      ...admins.map(
        (a) =>
          `• ${escapeHtml(a.display_name ?? (a.username ? `@${a.username}` : String(a.tg_user_id)))} — id <code>${a.tg_user_id}</code>${a.tg_user_id === rootId ? ' · корневой' : ''}`,
      ),
      '',
      `Передать права: ${code('/superadmin add <tgUserId> [имя]')}`,
      `Забрать: ${code('/superadmin del <tgUserId>')}`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}
