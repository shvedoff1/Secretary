import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { getProvider } from '../../core/registry.js';
import { ProviderError } from '../../core/provider.js';
import type { Member } from '../../core/types.js';
import { normalizeName } from '../../util/ids.js';
import { isAdmin } from '../../db/repos/users.repo.js';
import {
  getChatConfig,
  listChatConfigs,
  setProviderGroup,
  setDefaultCurrency,
} from '../../db/repos/chatConfig.repo.js';
import {
  listMappings,
  upsertMapping,
  deleteMapping,
} from '../../db/repos/memberMap.repo.js';
import {
  insertPinned,
  clearMemoryItems,
  listMemoryItemsForDisplay,
} from '../../db/repos/memoryItem.repo.js';
import { getLexicon } from '../../db/repos/lexicon.repo.js';
import { clearTurns } from '../../db/repos/conversation.repo.js';
import { replyLong } from '../../util/telegramText.js';

/** Gate: supreme admin only, and only in a private chat (other chats' data must
 * not leak into a group). Returns false (and replies) if not allowed. */
async function ensureAdminDM(ctx: Context): Promise<boolean> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    if (ctx.chat?.type === 'private') await ctx.reply('Команда только для администратора.');
    return false;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Админ-команды по чатам работают только в личке со мной.');
    return false;
  }
  return true;
}

function args(ctx: Context): string {
  return ((ctx.match as string | undefined) ?? '').trim();
}

/** Split "<id> <rest...>" → [idToken, rest]. */
function headTail(s: string): [string, string] {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s.trim());
  return m ? [m[1]!, m[2]!.trim()] : ['', ''];
}

function parseChatId(token: string): number | null {
  const id = Number(token);
  return Number.isInteger(id) && id !== 0 ? id : null;
}

async function membersOf(providerName: string, groupId: string): Promise<Member[]> {
  try {
    return await getProvider(providerName).listMembers({ groupId });
  } catch {
    return [];
  }
}

// --- /chats : list every configured chat -----------------------------------

export async function cmdChats(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const chats = listChatConfigs();
  if (chats.length === 0) {
    await ctx.reply('Пока нет настроенных чатов. Бота добавляют в группу и зовут /group там, либо настрой отсюда: /setgroup <chatId> <код>.');
    return;
  }
  const lines = chats.map((c) => {
    const group = c.provider_group_id ? '✓' : '✗';
    return `• ${c.title ?? '(без названия)'} — id ${c.chat_id}\n  ${c.provider_name}:${group} · ${c.default_currency}`;
  });
  await ctx.reply(
    [`Чаты (${chats.length}):`, ...lines, '', 'Детали: /chat <chatId>'].join('\n'),
  );
}

// --- /chat <id> : full detail ----------------------------------------------

export async function cmdChat(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const id = parseChatId(args(ctx));
  if (id === null) {
    await ctx.reply('Использование: /chat <chatId>');
    return;
  }
  // A chat_config row exists only for Splid-linked chats, but the bot learns
  // memory/slang in EVERY chat (keyed by chat_id). So don't bail when there's no
  // config — show whatever data we do hold for the chat; just note Splid is off.
  const cfg = getChatConfig(id);

  const mappings = listMappings(id);
  const linkedBy = new Map<string, number>();
  for (const m of mappings) linkedBy.set(m.provider_member_id, m.tg_user_id);

  const members = cfg?.provider_group_id
    ? await membersOf(cfg.provider_name, cfg.provider_group_id)
    : [];
  const roster = members.length
    ? members
        .map((m) => {
          const tg = linkedBy.get(m.id);
          return `   - ${m.name}${tg ? ` ↔ tg:${tg}` : ' (не привязан)'}`;
        })
        .join('\n')
    : '   (нет / группа не подключена)';

  const memItems = listMemoryItemsForDisplay(id, loadConfig().MEMORY_HALFLIFE_DAYS);
  const memory = memItems.length
    ? memItems
        .map((it) => `   - ${it.pinned ? '📌 ' : ''}${it.content}${it.scope === 'user' && it.subject ? ` (→ ${it.subject})` : ''}`)
        .join('\n')
    : '(пусто)';

  const slangCount = getLexicon(id).length;
  const slangLine = slangCount ? `сленг: ${slangCount} словечек (/slang ${id})` : 'сленг: (пусто)';

  const provider = cfg
    ? `${cfg.provider_name} (group ${cfg.provider_group_id ?? '—'})`
    : 'не настроен (не подключён к Splid)';

  // Memory/roster are open-ended, so chunk to stay under Telegram's 4096 cap —
  // a large chat would otherwise 400 and look like the command did nothing.
  await replyLong(
    ctx,
    [
      `Чат: ${cfg?.title ?? '(без названия)'}`,
      `id: ${id}`,
      `провайдер: ${provider}`,
      `валюта: ${cfg?.default_currency ?? loadConfig().DEFAULT_CURRENCY}`,
      `участники:`,
      roster,
      `память:`,
      memory,
      slangLine,
      ``,
      `Изменить: /setgroup ${id} <код> · /setcurrency ${id} <CUR> · /setmemory ${id} <текст> · /addmemory ${id} <текст> · /clearmemory ${id} · /setlink ${id} <tgUserId> <имя> · /unlink ${id} <tgUserId>`,
    ].join('\n'),
  );
}

// --- /setgroup <id> <code> --------------------------------------------------

export async function cmdSetGroup(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, code] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !code) {
    await ctx.reply('Использование: /setgroup <chatId> <код-приглашения Splid>');
    return;
  }
  const provider = getProvider('splid');
  let groupId: string;
  try {
    groupId = (await provider.connect(code)).groupId;
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : String(err);
    await ctx.reply(`Не удалось подключиться к Splid: ${msg}`);
    return;
  }
  setProviderGroup({
    chatId: id,
    providerName: 'splid',
    credential: code,
    providerGroupId: groupId,
    defaultCurrency: getChatConfig(id)?.default_currency ?? loadConfig().DEFAULT_CURRENCY,
    createdBy: ctx.from!.id,
  });
  const count = (await membersOf('splid', groupId)).length;
  await ctx.reply(`✅ Чат ${id} подключён к Splid (${count} участников).`);
}

// --- /setcurrency <id> <CUR> ------------------------------------------------

export async function cmdSetCurrency(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, cur] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !/^[A-Za-z]{3}$/.test(cur)) {
    await ctx.reply('Использование: /setcurrency <chatId> <ISO4217, напр. EUR>');
    return;
  }
  if (!getChatConfig(id)) {
    await ctx.reply(`Чат ${id} не настроен — сначала /setgroup ${id} <код>.`);
    return;
  }
  setDefaultCurrency(id, cur);
  await ctx.reply(`✅ Валюта чата ${id} → ${cur.toUpperCase()}.`);
}

// --- memory ----------------------------------------------------------------

export async function cmdSetMemory(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, text] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !text) {
    await ctx.reply('Использование: /setmemory <chatId> <текст> (заменяет память чата)');
    return;
  }
  // "Replace" the chat's memory: wipe stored items and pin this one note.
  clearMemoryItems(id);
  insertPinned(id, text);
  await ctx.reply(`🧠 Память чата ${id} перезаписана.`);
}

export async function cmdAddMemory(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, text] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !text) {
    await ctx.reply('Использование: /addmemory <chatId> <текст>');
    return;
  }
  insertPinned(id, text);
  await ctx.reply(`🧠 Добавил в память чата ${id}.`);
}

export async function cmdClearMemory(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const id = parseChatId(args(ctx));
  if (id === null) {
    await ctx.reply('Использование: /clearmemory <chatId>');
    return;
  }
  clearMemoryItems(id);
  clearTurns(id);
  await ctx.reply(`🧹 Память и история диалога чата ${id} очищены.`);
}

// --- member links -----------------------------------------------------------

export async function cmdSetLink(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, restA] = headTail(args(ctx));
  const [tgTok, query] = headTail(restA);
  const id = parseChatId(idTok);
  const tgUserId = Number(tgTok);
  if (id === null || !Number.isInteger(tgUserId) || !query) {
    await ctx.reply('Использование: /setlink <chatId> <tgUserId> <имя|инициалы участника Splid>');
    return;
  }
  const cfg = getChatConfig(id);
  if (!cfg?.provider_group_id) {
    await ctx.reply(`Чат ${id} не подключён к Splid (/setgroup ${id} <код>).`);
    return;
  }
  const members = await membersOf(cfg.provider_name, cfg.provider_group_id);
  const q = normalizeName(query);
  const member =
    members.find((m) => normalizeName(m.name) === q) ??
    members.find((m) => m.initials && normalizeName(m.initials) === q) ??
    members.find((m) => normalizeName(m.name).includes(q));
  if (!member) {
    await ctx.reply(`Не нашёл участника «${query}» в Splid этого чата. /chat ${id}`);
    return;
  }
  upsertMapping({
    chatId: id,
    tgUserId,
    providerMemberId: member.id,
    memberName: member.name,
  });
  await ctx.reply(`🔗 В чате ${id}: tg:${tgUserId} ↔ ${member.name}.`);
}

export async function cmdUnlink(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, tgTok] = headTail(args(ctx));
  const id = parseChatId(idTok);
  const tgUserId = Number(tgTok);
  if (id === null || !Number.isInteger(tgUserId)) {
    await ctx.reply('Использование: /unlink <chatId> <tgUserId>');
    return;
  }
  deleteMapping(id, tgUserId);
  await ctx.reply(`🔓 В чате ${id} привязка tg:${tgUserId} удалена.`);
}
