import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { getProvider } from '../../core/registry.js';
import { ProviderError } from '../../core/provider.js';
import type { Member } from '../../core/types.js';
import { normalizeName } from '../../util/ids.js';
import {
  canManageChat,
  chatLabel,
  isBotManager,
  isSupremeAdmin,
  managedChatIds,
  userLabel,
} from '../permissions.js';
import { listChatAdmins } from '../../db/repos/chatAdmin.repo.js';
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
  setItemScope,
  dedupeMemory,
  editMemoryItemContent,
  getAllItems,
  applyReconcilePlan,
} from '../../db/repos/memoryItem.repo.js';
import { reconcileMemory, type ReconcilePlan } from '../../llm/reconcile.js';
import {
  getChatMode,
  setChatMode,
  getPersonaPrompt,
  setPersonaPrompt,
  isChatTrusted,
  setChatTrusted,
  isChimeEnabled,
  setChimeEnabled,
  isChatHumorEnabled,
  isChatSlangEnabled,
  setChatHumorEnabled,
  isReactionsEnabled,
  setReactionsEnabled,
  getTimezone,
  listKnownChats,
} from '../../db/repos/chatSettings.repo.js';
import { getLexicon } from '../../db/repos/lexicon.repo.js';
import { clearTurns } from '../../db/repos/conversation.repo.js';
import { clearLog, countLog, oldestLoggedAt } from '../../db/repos/chatLog.repo.js';
import { formatInTimezone } from '../../util/schedule.js';
import { replyLong } from '../../util/telegramText.js';
import { escapeHtml } from '../../util/telegramHtml.js';
import {
  applyModeDefaults,
  modeSpec,
  parseMode,
  renderModeCard,
  renderSetupCard,
  MODE_NAMES,
} from '../../modes.js';
import { modeKeyboard } from '../keyboards.js';
import { countRules } from '../../db/repos/chatRule.repo.js';

/**
 * Gate for per-chat admin commands: DM-only (other chats' data must not leak
 * into a group), and the caller must MANAGE the target chat — supreme admins
 * manage every chat, chat admins only the chats granted to them (see /admins).
 * Pass chatId = null before the id is parsed/known: then only "is any kind of
 * admin" is checked, so usage hints stay visible to chat admins too.
 * Returns false (and replies) if not allowed.
 */
async function ensureManagerDM(ctx: Context, chatId: number | null): Promise<boolean> {
  const uid = ctx.from?.id;
  if (!uid || !isBotManager(uid)) {
    if (ctx.chat?.type === 'private') await ctx.reply('Команда только для админов бота.');
    return false;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Админ-команды по чатам работают только в личке со мной.');
    return false;
  }
  if (chatId !== null && !canManageChat(uid, chatId)) {
    await ctx.reply(`Чат ${chatId} не под твоим управлением. Твои чаты: /chats`);
    return false;
  }
  return true;
}

/** Tap-to-copy command markup (Telegram copies a <code> block on tap). */
function code(cmd: string): string {
  return `<code>${escapeHtml(cmd)}</code>`;
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

// --- /chatlog : inspect or wipe a chat's raw message log --------------------

/**
 * The raw log is what `summarize_chat` reads back, so the admin needs to see how
 * far it reaches (and be able to wipe it — the one thing nobody wants to discover
 * they can't do about a recording of their group chat).
 */
export async function cmdChatLog(ctx: Context): Promise<void> {
  const cfg = loadConfig();
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /chatlog <chatId> [clear]');
    return;
  }
  const want = rest.trim().toLowerCase();
  if (want === 'clear') {
    clearLog(id);
    await ctx.reply(`🧹 Чат ${id}: лог сообщений очищен — пересказывать больше нечего.`);
    return;
  }
  if (want) {
    await ctx.reply('Использование: /chatlog <chatId> [clear]');
    return;
  }
  if (!cfg.ENABLE_CHAT_LOG) {
    await ctx.reply('Логирование сообщений выключено глобально (ENABLE_CHAT_LOG=false).');
    return;
  }
  const total = countLog(id);
  const oldest = oldestLoggedAt(id);
  const since = oldest
    ? formatInTimezone(oldest, getTimezone(id) ?? cfg.DEFAULT_TIMEZONE)
    : '—';
  await ctx.reply(
    `Чат ${id}: в логе ${total} сообщений, самое старое от ${since}.\n` +
      `Держу максимум ${cfg.CHAT_LOG_KEEP_PER_CHAT} и не старше ${cfg.CHAT_LOG_RETENTION_DAYS} дней.\n` +
      `Очистить: /chatlog ${id} clear`,
  );
}

// --- /chats : the chats YOU manage, with tap-to-copy commands ---------------

/**
 * The DM home screen for anyone with admin rights: which chats are under your
 * management and what to do next with each. A supreme admin sees every chat the
 * bot knows (configured, trusted, or just titled); a chat admin sees only the
 * chats granted to them. Every command is a <code> block, so managing a chat is
 * tap-to-copy — nobody types -100… ids by hand.
 */
export async function cmdChats(ctx: Context): Promise<void> {
  if (!(await ensureManagerDM(ctx, null))) return;
  const uid = ctx.from!.id;
  const managed = managedChatIds(uid);
  const supreme = managed === 'all';

  // Supreme: union of Splid-configured chats and every chat with settings
  // (trusted / mode-set / titled). Chat admin: exactly the granted list.
  let ids: number[];
  if (supreme) {
    const set = new Set<number>();
    for (const c of listChatConfigs()) set.add(c.chat_id);
    for (const c of listKnownChats()) set.add(c.chat_id);
    ids = [...set];
  } else {
    ids = managed;
  }

  if (ids.length === 0) {
    await ctx.reply(
      supreme
        ? 'Пока нет настроенных чатов. Добавь меня в группу — пришлю сюда уведомление с выбором режима.'
        : 'За тобой пока не закреплён ни один чат — попроси верховного админа выдать права (/admins).',
    );
    return;
  }

  const lines = ids.map((id) => {
    const cfg = getChatConfig(id);
    const bits = [
      `режим ${modeSpec(getChatMode(id)).label}`,
      cfg?.provider_group_id ? `Splid ✓ (${cfg.default_currency})` : null,
      isChatTrusted(id) ? 'доверенный' : null,
    ].filter(Boolean);
    return `• <b>${escapeHtml(chatLabel(id))}</b> — ${bits.join(' · ')}\n  настройки: ${code(`/chat ${id}`)}`;
  });

  await replyLong(
    ctx,
    [
      supreme ? `Чаты (${ids.length}):` : `Твои чаты (${ids.length}):`,
      ...lines,
      '',
      'Команды копируются тапом. С каждым чатом можно: сменить режим и правила поведения, ' +
        'включать/выключать юмор, сленг, вбросы и реакции, править память и сленг, ' +
        `смотреть лог и подключать Splid — всё внутри ${code('/chat <id>')}.`,
      ...(supreme
        ? [`Выдать кому-то права на чат: ${code('/admins <chatId> add <tgUserId>')} — детали в /help.`]
        : []),
    ].join('\n'),
    { html: true },
  );
}

// --- /chat <id> : full detail ----------------------------------------------

export async function cmdChat(ctx: Context): Promise<void> {
  const id = parseChatId(args(ctx));
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /chat <chatId> — список твоих чатов с готовыми командами: /chats');
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
          return `   - ${escapeHtml(m.name)}${tg ? ` ↔ tg:${tg}` : ' (не привязан)'}`;
        })
        .join('\n')
    : '   (нет / группа не подключена)';

  // Only the top slice: the store is deep (MEMORY_MAX_ITEMS), and dumping it all
  // would chunk into dozens of messages. Indexes still match the full list, so
  // /editmemory, /persona and /forget address anything shown.
  const memLimit = loadConfig().MEMORY_DISPLAY_LIMIT;
  const memItems = listMemoryItemsForDisplay(id, loadConfig().MEMORY_HALFLIFE_DAYS);
  const memHidden = Math.max(0, memItems.length - memLimit);
  const memory = memItems.length
    ? memItems
        .slice(0, memLimit)
        .map((it, i) => {
          const tag = it.scope === 'persona' ? '🎭 ' : it.pinned ? '📌 ' : '';
          const who = it.scope === 'user' && it.subject ? ` (→ ${escapeHtml(it.subject)})` : '';
          return `   ${i + 1}. ${tag}${escapeHtml(it.content)}${who}`;
        })
        .join('\n') + (memHidden > 0 ? `\n   …и ещё ${memHidden} (показываю ${memLimit})` : '')
    : '(пусто)';

  const ruleCount = countRules(id);
  const rulesLine =
    ruleCount > 0
      ? `правила поведения: ${ruleCount} (посмотреть: ${code(`/rules ${id}`)})`
      : `правила поведения: нет (задать: ${code(`/rules ${id} add <текст>`)})`;

  const slangCount = getLexicon(id).length;
  const slangState = isChatSlangEnabled(id) ? 'вкл' : 'выкл';
  const slangLine =
    `сленг в ответах: ${slangState} (${code(`/slang ${id} on|off`)}) · ` +
    (slangCount ? `выучено ${slangCount} словечек (${code(`/slang ${id}`)})` : 'выучено: (пусто)');

  // Who runs this chat: its chat admins (if any) — supreme admins run everything
  // and are listed in /help, not per chat.
  const chatAdmins = listChatAdmins(id);
  const adminsLine = chatAdmins.length
    ? `админы чата: ${chatAdmins.map((a) => escapeHtml(userLabel(a.tg_user_id))).join(', ')}` +
      (isSupremeAdmin(ctx.from!.id) ? ` (управлять: ${code(`/admins ${id}`)})` : '')
    : isSupremeAdmin(ctx.from!.id)
      ? `админы чата: нет (назначить: ${code(`/admins ${id} add <tgUserId>`)})`
      : 'админы чата: только ты и верховные админы';

  const provider = cfg
    ? `${escapeHtml(cfg.provider_name)} (group ${escapeHtml(cfg.provider_group_id ?? '—')})`
    : 'не настроен (не подключён к Splid)';

  // Memory/roster are open-ended, so chunk to stay under Telegram's 4096 cap —
  // a large chat would otherwise 400 and look like the command did nothing.
  // HTML mode: dynamic content is escaped above, commands are tap-to-copy.
  await replyLong(
    ctx,
    [
      `Чат: <b>${escapeHtml(chatLabel(id))}</b>`,
      `id: <code>${id}</code>`,
      `пресет: ${modeSpec(getChatMode(id)).label} (сменить кнопками: ${code(`/mode ${id}`)}, или ${code(`/mode ${id} <${MODE_NAMES}>`)})`,
      ...(getChatMode(id) === 'custom'
        ? [
            `свой характер: ${getPersonaPrompt(id) ? 'задан' : 'не задан'} (${code(`/prompt ${id}`)})`,
          ]
        : []),
      `поведение (что такое юморайзер, сленг, вбросы, реакции): ${code(`/setup ${id}`)}`,
      `доступ: ${isChatTrusted(id) ? 'доверенный чат — все участники' : 'только /whitelist' + (cfg?.provider_group_id ? ' + участники Splid-группы' : '')} (${code(`/trust ${id} on|off`)})`,
      adminsLine,
      `вбросы в тишину: ${isChimeEnabled(id) ? 'вкл' : 'выкл'} (${code(`/chime ${id} on|off`)})`,
      `юморайзер: ${isChatHumorEnabled(id) ? 'вкл' : 'выкл'} (${code(`/humor ${id} on|off`)})`,
      `рандомные реакции: ${isReactionsEnabled(id) ? 'вкл' : 'выкл'} (${code(`/react ${id} on|off`)})`,
      rulesLine,
      `провайдер: ${provider}`,
      `валюта: ${cfg?.default_currency ?? loadConfig().DEFAULT_CURRENCY}`,
      `участники:`,
      roster,
      `память: ${memItems.length} записей`,
      memory,
      slangLine,
      ``,
      `Изменить (тапни, чтобы скопировать): ${[
        code(`/prompt ${id} <текст>`),
        code(`/setgroup ${id} <код>`),
        code(`/setcurrency ${id} <CUR>`),
        code(`/setmemory ${id} <текст>`),
        code(`/addmemory ${id} <текст>`),
        code(`/persona ${id} <N|текст>`),
        code(`/editmemory ${id} <N> <текст>`),
        code(`/dedupememory ${id}`),
        code(`/reconcile ${id}`),
        code(`/clearmemory ${id}`),
        code(`/chatlog ${id}`),
        code(`/setlink ${id} <tgUserId> <имя>`),
        code(`/unlink ${id} <tgUserId>`),
      ].join(' · ')}`,
    ].join('\n'),
    { html: true },
  );
}

// --- /setgroup <id> <code> --------------------------------------------------

export async function cmdSetGroup(ctx: Context): Promise<void> {
  const [idTok, inviteCode] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null || !inviteCode) {
    await ctx.reply('Использование: /setgroup <chatId> <код-приглашения Splid>');
    return;
  }
  const provider = getProvider('splid');
  let groupId: string;
  try {
    groupId = (await provider.connect(inviteCode)).groupId;
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : String(err);
    await ctx.reply(`Не удалось подключиться к Splid: ${msg}`);
    return;
  }
  setProviderGroup({
    chatId: id,
    providerName: 'splid',
    credential: inviteCode,
    providerGroupId: groupId,
    defaultCurrency: getChatConfig(id)?.default_currency ?? loadConfig().DEFAULT_CURRENCY,
    createdBy: ctx.from!.id,
  });
  const count = (await membersOf('splid', groupId)).length;
  await ctx.reply(`✅ Чат ${id} подключён к Splid (${count} участников).`);
}

// --- /setcurrency <id> <CUR> ------------------------------------------------

export async function cmdSetCurrency(ctx: Context): Promise<void> {
  const [idTok, cur] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
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

// --- /modes, /mode <id> [<режим>] : chat persona ------------------------------

/**
 * `/modes` — what the modes are, in one message. The same card the picker's
 * «Что за режимы?» button shows, so an admin can read it before touching a chat.
 */
export async function cmdModes(ctx: Context): Promise<void> {
  if (!(await ensureManagerDM(ctx, null))) return;
  await replyLong(
    ctx,
    `Пресеты характера:\n\n${renderModeCard()}\n\n` +
      `Поставить: /mode <chatId> ${MODE_NAMES} — или /mode <chatId> без режима, ` +
      `тогда покажу кнопками. Выбор пресета открывает доступ всем участникам чата и ` +
      `включает его стартовые настройки (юмор, сленг, вбросы, реакции) — потом каждую ` +
      `можно крутить отдельно, карта: /setup <chatId>.\n` +
      `Свой характер словами: /prompt <chatId> <текст>. ` +
      `Поведение донастраивается правилами: /rules <chatId> add <текст>.`,
  );
}

/**
 * `/mode <chatId>` shows the chat's persona AND the picker buttons (the same one
 * the "bot was added" DM offers, so switching is a tap, not a memorised word);
 * `/mode <chatId> <режим>` switches it straight away. For a personal chat the
 * chatId is just the person's telegram id — so `/mode <kid_tg_id> tutor` turns the
 * kid's DM into a strict exam-prep tutor, and `/mode <group_id> assistant` turns a
 * group into the calm, personality-free helper.
 */
export async function cmdMode(ctx: Context): Promise<void> {
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply(
      `Использование: /mode <chatId> [${MODE_NAMES}]\n` +
        'Для лички chatId = telegram id человека (см. /whitelist).\n' +
        'Что за режимы — /modes.',
    );
    return;
  }
  const want = rest.trim();
  if (!want) {
    const trust = isChatTrusted(id) ? 'доверенный (доступ у всех участников)' : 'не доверенный';
    await ctx.reply(
      `Режим чата ${id}: ${modeSpec(getChatMode(id)).label}\nДоступ: ${trust}\n\n` +
        `Сменить — кнопкой ниже (описания: «Что за режимы?»).`,
      { reply_markup: modeKeyboard(id) },
    );
    return;
  }
  const mode = parseMode(want);
  if (!mode) {
    await ctx.reply(`Такого режима нет. Бывают: ${MODE_NAMES} (описания — /modes).`);
    return;
  }
  setChatMode(id, mode);
  // Setting a mode is an explicit admin act of configuring the chat — trust it,
  // so a group switched to e.g. dota immediately works for every participant.
  setChatTrusted(id, true);
  // The preset's tone stances become the chat's own switches; the setup card
  // below explains what each one does and how to re-toggle it.
  applyModeDefaults(id, modeSpec(mode));
  await ctx.reply(
    `✅ Чат ${id} → ${modeSpec(mode).label}. Чат доверенный — доступ у всех участников ` +
      `(закрыть: /trust ${id} off).`,
  );
  await replyLong(ctx, renderSetupCard(id), { html: true });
}

// --- /setup <id> : the behaviour walkthrough --------------------------------

/**
 * `/setup <chatId>` — the behaviour card: what the humorizer, slang, chime and
 * reactions actually DO, their current state in the chat, and the tap-to-copy
 * command for each. The same card is shown right after a preset is picked.
 */
export async function cmdSetup(ctx: Context): Promise<void> {
  const id = parseChatId(args(ctx));
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /setup <chatId> — покажу, что можно крутить в поведении чата.');
    return;
  }
  await replyLong(ctx, renderSetupCard(id), { html: true });
}

// --- /prompt <id> [<текст>|clear] : the custom personality --------------------

/** Longest persona description accepted — it is paid for in tokens on every turn. */
const PERSONA_PROMPT_MAX_CHARS = 2000;

/**
 * `/prompt <chatId> <текст>` — describe the bot's character in your own words
 * («ты дворецкий-аристократ, вежлив до занудства»). The text becomes a persona
 * override on the system prompt AND the voice of the tone pass, and the chat is
 * switched to the «кастом» preset (with its default toggles) if it wasn't there
 * yet. `/prompt <chatId>` shows the current description; `clear` drops it (the
 * chat then behaves like the calm assistant until a new one is set).
 */
export async function cmdPrompt(ctx: Context): Promise<void> {
  const [idTok, text] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply(
      'Использование: /prompt <chatId> <текст> — свой характер бота своими словами.\n' +
        'Посмотреть: /prompt <chatId> · убрать: /prompt <chatId> clear',
    );
    return;
  }

  if (!text) {
    const current = getPersonaPrompt(id);
    const mode = getChatMode(id);
    await ctx.reply(
      current
        ? `Характер чата ${id} (пресет ${modeSpec(mode).label}):\n\n«${current}»\n\n` +
            `Заменить: /prompt ${id} <текст> · убрать: /prompt ${id} clear`
        : `Свой характер для чата ${id} не задан. Задать: /prompt ${id} <текст> — ` +
            `опиши персону словами («ты дворецкий-аристократ, вежлив до занудства»), ` +
            `я переключу чат в пресет «кастом» и буду её отыгрывать.`,
    );
    return;
  }

  if (text.toLowerCase() === 'clear') {
    setPersonaPrompt(id, null);
    await ctx.reply(
      `🧽 Характер чата ${id} стёрт. ` +
        (getChatMode(id) === 'custom'
          ? `Пресет остался «кастом» — без описания веду себя как спокойный ассистент. ` +
            `Новый характер: /prompt ${id} <текст>, или смени пресет: /mode ${id}.`
          : `Задать новый: /prompt ${id} <текст>.`),
    );
    return;
  }

  if (text.length > PERSONA_PROMPT_MAX_CHARS) {
    await ctx.reply(
      `Слишком длинно (${text.length} символов, максимум ${PERSONA_PROMPT_MAX_CHARS}) — ` +
        `это читается на каждом сообщении. Сократи до сути: кто персонаж, как говорит, пара фишек.`,
    );
    return;
  }

  setPersonaPrompt(id, text);
  const wasCustom = getChatMode(id) === 'custom';
  if (!wasCustom) {
    // Setting a persona IS choosing the custom preset — switch, trust (an explicit
    // admin act of configuring the chat) and apply the preset's default toggles.
    setChatMode(id, 'custom');
    setChatTrusted(id, true);
    applyModeDefaults(id, modeSpec('custom'));
  }
  await ctx.reply(
    `🎭 Чат ${id}: характер записан${wasCustom ? '' : `, пресет → ${modeSpec('custom').label}`}. ` +
      `Говорю в этом образе со следующего ответа.`,
  );
  if (!wasCustom) await replyLong(ctx, renderSetupCard(id), { html: true });
}

// --- /trust <id> [on|off] : whole-chat access ------------------------------

/**
 * `/trust <chatId>` shows whether the chat's participants pass the auth gate;
 * `/trust <chatId> on|off` grants/revokes it. Picking a mode (buttons or /mode)
 * already trusts a chat — this is the manual switch and the revoke lever.
 */
export async function cmdTrust(ctx: Context): Promise<void> {
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /trust <chatId> [on|off]');
    return;
  }
  const want = rest.trim().toLowerCase();
  if (!want) {
    await ctx.reply(
      isChatTrusted(id)
        ? `Чат ${id} доверенный — доступ у всех участников. Закрыть: /trust ${id} off`
        : `Чат ${id} не доверенный — работают только люди из /whitelist. Открыть: /trust ${id} on`,
    );
    return;
  }
  if (want !== 'on' && want !== 'off') {
    await ctx.reply('Использование: /trust <chatId> [on|off]');
    return;
  }
  setChatTrusted(id, want === 'on');
  await ctx.reply(
    want === 'on'
      ? `✅ Чат ${id} доверенный — доступ открыт всем его участникам.`
      : `🚫 Чат ${id} больше не доверенный — доступ только по /whitelist (Splid-подключение, если есть, всё ещё даёт доступ).`,
  );
}

// --- /chime <id> [on|off] : spontaneous chime-in per chat --------------------

/**
 * `/chime <chatId>` shows whether the bot may spontaneously chime into that
 * chat's lulls; `/chime <chatId> on|off` toggles it. Off = the random revive
 * message never fires there (the global ENABLE_CHIME flag still master-gates
 * the feature everywhere).
 */
export async function cmdChime(ctx: Context): Promise<void> {
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /chime <chatId> [on|off]');
    return;
  }
  const want = rest.trim().toLowerCase();
  if (!want) {
    await ctx.reply(
      isChimeEnabled(id)
        ? `Чат ${id}: рандомные вбросы в тишину ВКЛючены. Выключить: /chime ${id} off`
        : `Чат ${id}: рандомные вбросы в тишину ВЫКЛючены. Включить: /chime ${id} on`,
    );
    return;
  }
  if (want !== 'on' && want !== 'off') {
    await ctx.reply('Использование: /chime <chatId> [on|off]');
    return;
  }
  setChimeEnabled(id, want === 'on');
  await ctx.reply(
    want === 'on'
      ? `✅ Чат ${id}: рандомные вбросы включены.`
      : `🔇 Чат ${id}: рандомные вбросы выключены полностью.`,
  );
}

// --- /humor <id> [on|off] : OpenAI humor passes per chat ---------------------

/**
 * `/humor <chatId>` shows whether the OpenAI humor passes run for that chat;
 * `/humor <chatId> on|off` toggles them. Off = the tone-rewrite humorizer,
 * humour tasks, the spending-digest rewrite and the expense quip are ALL
 * skipped for the chat — replies ship as Claude wrote them. The global
 * ENABLE_HUMOR / ENABLE_EXPENSE_QUIP flags still master-gate everything.
 */
export async function cmdHumor(ctx: Context): Promise<void> {
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /humor <chatId> [on|off]');
    return;
  }
  const want = rest.trim().toLowerCase();
  if (!want) {
    await ctx.reply(
      isChatHumorEnabled(id)
        ? `Чат ${id}: юморайзер ВКЛючен. Выключить: /humor ${id} off`
        : `Чат ${id}: юморайзер ВЫКЛючен. Включить: /humor ${id} on`,
    );
    return;
  }
  if (want !== 'on' && want !== 'off') {
    await ctx.reply('Использование: /humor <chatId> [on|off]');
    return;
  }
  setChatHumorEnabled(id, want === 'on');
  await ctx.reply(
    want === 'on'
      ? `✅ Чат ${id}: юморайзер включен.`
      : `😐 Чат ${id}: юморайзер выключен полностью (тон-пасс, юмор-задачи, сводка трат, квипы).`,
  );
}

// --- /react <id> [on|off] : random auto-reactions per chat -------------------

/**
 * `/react <chatId>` shows whether random auto-reactions run in that chat;
 * `/react <chatId> on|off` toggles them. Off = the ~10% positive-emoji
 * seasoning never fires there.
 */
export async function cmdReact(ctx: Context): Promise<void> {
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /react <chatId> [on|off]');
    return;
  }
  const want = rest.trim().toLowerCase();
  if (!want) {
    await ctx.reply(
      isReactionsEnabled(id)
        ? `Чат ${id}: рандомные реакции ВКЛючены. Выключить: /react ${id} off`
        : `Чат ${id}: рандомные реакции ВЫКЛючены. Включить: /react ${id} on`,
    );
    return;
  }
  if (want !== 'on' && want !== 'off') {
    await ctx.reply('Использование: /react <chatId> [on|off]');
    return;
  }
  setReactionsEnabled(id, want === 'on');
  await ctx.reply(
    want === 'on'
      ? `✅ Чат ${id}: рандомные реакции включены.`
      : `😶 Чат ${id}: рандомные реакции выключены полностью.`,
  );
}

// --- memory ----------------------------------------------------------------

export async function cmdSetMemory(ctx: Context): Promise<void> {
  const [idTok, text] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
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
  const [idTok, text] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null || !text) {
    await ctx.reply('Использование: /addmemory <chatId> <текст>');
    return;
  }
  insertPinned(id, text);
  await ctx.reply(`🧠 Добавил в память чата ${id}.`);
}

export async function cmdClearMemory(ctx: Context): Promise<void> {
  const id = parseChatId(args(ctx));
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /clearmemory <chatId>');
    return;
  }
  clearMemoryItems(id);
  clearTurns(id);
  await ctx.reply(`🧹 Память и история диалога чата ${id} очищены.`);
}

/**
 * `/persona <chatId> <N>` reclassifies memory item #N (as numbered in /chat and
 * /memory) into the chat's voice/style bucket, so a tone directive stops competing
 * with factual chat memory for the context budget. `/persona <chatId> <текст>` pins a
 * brand-new style line straight into that bucket.
 */
export async function cmdPersona(ctx: Context): Promise<void> {
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null || !rest) {
    await ctx.reply(
      'Использование: /persona <chatId> <N> (перенести пункт #N из /chat в стиль) ' +
        'или /persona <chatId> <текст> (добавить новую стилевую строку).',
    );
    return;
  }
  // A bare integer targets an existing item by its /chat index; anything else is text.
  if (/^\d+$/.test(rest)) {
    const n = Number(rest);
    const items = listMemoryItemsForDisplay(id, loadConfig().MEMORY_HALFLIFE_DAYS);
    const target = items[n - 1];
    if (!target) {
      await ctx.reply(`Нет пункта №${n} в памяти чата ${id}. Список: /chat ${id}`);
      return;
    }
    if (target.scope === 'persona') {
      await ctx.reply(`Пункт №${n} уже в стиле (🎭).`);
      return;
    }
    const moved = setItemScope(id, target.id, 'persona');
    await ctx.reply(`🎭 Перенёс в стиль чата ${id}: ${moved ?? target.content}`);
    return;
  }
  insertPinned(id, rest, { scope: 'persona' });
  await ctx.reply(`🎭 Добавил в стиль чата ${id}.`);
}

/**
 * `/editmemory <chatId> <N> <текст>` overwrites memory item #N (as numbered in /chat
 * and /memory) in place — fix a typo or a wrong detail without removing/re-adding.
 */
export async function cmdEditMemory(ctx: Context): Promise<void> {
  const [idTok, restA] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  const [nTok, text] = headTail(restA);
  const n = Number(nTok);
  if (id === null || !Number.isInteger(n) || n < 1 || !text) {
    await ctx.reply('Использование: /editmemory <chatId> <N> <новый текст>');
    return;
  }
  const items = listMemoryItemsForDisplay(id, loadConfig().MEMORY_HALFLIFE_DAYS);
  const target = items[n - 1];
  if (!target) {
    await ctx.reply(`Нет пункта №${n} в памяти чата ${id}. Список: /chat ${id}`);
    return;
  }
  const old = editMemoryItemContent(id, target.id, text);
  await ctx.reply(`✏️ Пункт №${n} чата ${id}: «${old ?? target.content}» → «${text}».`);
}

// A reconciliation plan awaiting the admin's `apply`, per chat. In-memory and
// ephemeral (like the other admin/session state) — a restart just means re-running the
// dry-run, which is cheap and safe.
const pendingReconcile = new Map<number, ReconcilePlan>();

/**
 * `/reconcile <chatId>` runs an LLM pass over the WHOLE store to find semantic
 * contradictions / stale / duplicate facts and shows a dry-run of what it would remove
 * or rewrite (nothing is changed yet). `/reconcile <chatId> apply` applies the last
 * previewed plan. This is the cleanup for accumulated conflicts that /dedupememory (exact
 * duplicates only) can't catch.
 */
export async function cmdReconcile(ctx: Context): Promise<void> {
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /reconcile <chatId> (превью), затем /reconcile <chatId> apply');
    return;
  }

  if (rest.trim().toLowerCase() === 'apply') {
    const plan = pendingReconcile.get(id);
    if (!plan) {
      await ctx.reply(`Нет готового плана для ${id}. Сначала /reconcile ${id} для превью.`);
      return;
    }
    const { edited, deleted } = applyReconcilePlan(id, plan);
    pendingReconcile.delete(id);
    await ctx.reply(`✅ Применил к чату ${id}: убрал ${deleted}, поправил ${edited}. Глянь /chat ${id}.`);
    return;
  }

  const items = getAllItems(id);
  if (items.length === 0) {
    await ctx.reply(`Память чата ${id} пуста — чистить нечего.`);
    return;
  }
  await ctx.reply('🧠 Думаю над противоречиями… (это займёт пару секунд)');
  const plan = await reconcileMemory(items);
  if (plan === null) {
    await ctx.reply('⚠️ Не смог обратиться к ИИ. Попробуй ещё раз чуть позже.');
    return;
  }
  if (plan.deletes.length === 0 && plan.edits.length === 0) {
    await ctx.reply('Явных противоречий не нашёл. 🤙');
    return;
  }

  // Preview by CONTENT (not #id) so the admin reads exactly what would change.
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: string[] = [];
  for (const e of plan.edits) {
    const it = byId.get(e.id);
    if (it) lines.push(`✏️ «${it.content}» → «${e.content}»${e.reason ? ` — ${e.reason}` : ''}`);
  }
  for (const d of plan.deletes) {
    const it = byId.get(d.id);
    if (it) lines.push(`🗑 «${it.content}»${d.reason ? ` — ${d.reason}` : ''}`);
  }
  pendingReconcile.set(id, plan);
  await replyLong(
    ctx,
    `Нашёл на чистку в чате ${id} (${lines.length}) — это ПРЕВЬЮ, ничего не тронул:\n\n` +
      `${lines.join('\n')}\n\nПрименить: /reconcile ${id} apply`,
  );
}

/** `/dedupememory <chatId>` folds duplicate memory items into one pass. */
export async function cmdDedupeMemory(ctx: Context): Promise<void> {
  const id = parseChatId(args(ctx));
  if (!(await ensureManagerDM(ctx, id))) return;
  if (id === null) {
    await ctx.reply('Использование: /dedupememory <chatId>');
    return;
  }
  const removed = dedupeMemory(id, loadConfig().MEMORY_HALFLIFE_DAYS);
  await ctx.reply(
    removed > 0
      ? `🧹 Схлопнул дубли в памяти чата ${id}: убрал ${removed}. Глянь /chat ${id}.`
      : `Дублей в памяти чата ${id} не нашёл.`,
  );
}

// --- member links -----------------------------------------------------------

export async function cmdSetLink(ctx: Context): Promise<void> {
  const [idTok, restA] = headTail(args(ctx));
  const [tgTok, query] = headTail(restA);
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
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
  const [idTok, tgTok] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (!(await ensureManagerDM(ctx, id))) return;
  const tgUserId = Number(tgTok);
  if (id === null || !Number.isInteger(tgUserId)) {
    await ctx.reply('Использование: /unlink <chatId> <tgUserId>');
    return;
  }
  deleteMapping(id, tgUserId);
  await ctx.reply(`🔓 В чате ${id} привязка tg:${tgUserId} удалена.`);
}
