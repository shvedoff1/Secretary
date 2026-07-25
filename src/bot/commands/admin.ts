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
  isChatTrusted,
  setChatTrusted,
  isChimeEnabled,
  setChimeEnabled,
  isChatHumorEnabled,
  setChatHumorEnabled,
  type ChatMode,
} from '../../db/repos/chatSettings.repo.js';
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
        .map((it, i) => {
          const tag = it.scope === 'persona' ? '🎭 ' : it.pinned ? '📌 ' : '';
          const who = it.scope === 'user' && it.subject ? ` (→ ${it.subject})` : '';
          return `   ${i + 1}. ${tag}${it.content}${who}`;
        })
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
      `режим: ${MODE_LABEL[getChatMode(id)]} (сменить: /mode ${id} tutor|secretary|dota)`,
      `доступ: ${isChatTrusted(id) ? 'доверенный чат — все участники' : 'только /whitelist' + (cfg?.provider_group_id ? ' + участники Splid-группы' : '')} (/trust ${id} on|off)`,
      `вбросы в тишину: ${isChimeEnabled(id) ? 'вкл' : 'выкл'} (/chime ${id} on|off)`,
      `юморайзер: ${isChatHumorEnabled(id) ? 'вкл' : 'выкл'} (/humor ${id} on|off)`,
      `провайдер: ${provider}`,
      `валюта: ${cfg?.default_currency ?? loadConfig().DEFAULT_CURRENCY}`,
      `участники:`,
      roster,
      `память:`,
      memory,
      slangLine,
      ``,
      `Изменить: /setgroup ${id} <код> · /setcurrency ${id} <CUR> · /setmemory ${id} <текст> · /addmemory ${id} <текст> · /persona ${id} <N|текст> · /editmemory ${id} <N> <текст> · /dedupememory ${id} · /reconcile ${id} · /clearmemory ${id} · /setlink ${id} <tgUserId> <имя> · /unlink ${id} <tgUserId>`,
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

// --- /mode <id> [tutor|secretary] : chat persona ------------------------------

const MODE_LABEL: Record<ChatMode, string> = {
  secretary: '🤙 секретарь (обычный ассистент)',
  tutor: '🎓 репетитор (подготовка к экзаменам, точность, без юмора)',
  dota: '🎮 дота (пинг пати через /dota, школьник-«сенсей» по Dota 2)',
};

/**
 * `/mode <chatId>` shows the chat's persona; `/mode <chatId> tutor|secretary|dota`
 * switches it. For a personal chat the chatId is just the person's telegram id —
 * so `/mode <kid_tg_id> tutor` turns the kid's DM with the bot into a strict
 * exam-prep tutor, and `/mode <group_id> dota` turns a group into the dota
 * ping-bot (full secretary feature set, dota-teacher persona).
 */
export async function cmdMode(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null) {
    await ctx.reply(
      'Использование: /mode <chatId> [tutor|secretary|dota]\n' +
        'Для лички chatId = telegram id человека (см. /whitelist).',
    );
    return;
  }
  const want = rest.trim().toLowerCase();
  if (!want) {
    const trust = isChatTrusted(id) ? 'доверенный (доступ у всех участников)' : 'не доверенный';
    await ctx.reply(`Режим чата ${id}: ${MODE_LABEL[getChatMode(id)]}\nДоступ: ${trust}`);
    return;
  }
  if (want !== 'tutor' && want !== 'secretary' && want !== 'dota') {
    await ctx.reply('Режим бывает только tutor, secretary или dota.');
    return;
  }
  setChatMode(id, want);
  // Setting a mode is an explicit admin act of configuring the chat — trust it,
  // so a group switched to e.g. dota immediately works for every participant.
  setChatTrusted(id, true);
  await ctx.reply(
    `✅ Чат ${id} → ${MODE_LABEL[want]}. Чат доверенный — доступ у всех участников ` +
      `(закрыть: /trust ${id} off).`,
  );
}

// --- /trust <id> [on|off] : whole-chat access ------------------------------

/**
 * `/trust <chatId>` shows whether the chat's participants pass the auth gate;
 * `/trust <chatId> on|off` grants/revokes it. Picking a mode (buttons or /mode)
 * already trusts a chat — this is the manual switch and the revoke lever.
 */
export async function cmdTrust(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
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
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
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
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
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

/**
 * `/persona <chatId> <N>` reclassifies memory item #N (as numbered in /chat and
 * /memory) into the chat's voice/style bucket, so a tone directive stops competing
 * with factual chat memory for the context budget. `/persona <chatId> <текст>` pins a
 * brand-new style line straight into that bucket.
 */
export async function cmdPersona(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
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
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, restA] = headTail(args(ctx));
  const id = parseChatId(idTok);
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
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, rest] = headTail(args(ctx));
  const id = parseChatId(idTok);
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
  if (!(await ensureAdminDM(ctx))) return;
  const id = parseChatId(args(ctx));
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
