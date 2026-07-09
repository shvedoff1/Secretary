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
import { getLexicon } from '../../db/repos/lexicon.repo.js';
import { clearTurns } from '../../db/repos/conversation.repo.js';
import { replyLong } from '../../util/telegramText.js';
import { t } from '../../i18n/index.js';

/** Gate: supreme admin only, and only in a private chat (other chats' data must
 * not leak into a group). Returns false (and replies) if not allowed. */
async function ensureAdminDM(ctx: Context): Promise<boolean> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    if (ctx.chat?.type === 'private') await ctx.reply(t('admin.adminOnly'));
    return false;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply(t('admin.adminDmOnly'));
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
    await ctx.reply(t('admin.noChatsConfigured'));
    return;
  }
  const lines = chats.map((c) => {
    const group = c.provider_group_id ? '✓' : '✗';
    return t('admin.chatsListLine', {
      title: c.title ?? t('admin.untitled'),
      chatId: c.chat_id,
      provider: c.provider_name,
      group,
      currency: c.default_currency,
    });
  });
  await ctx.reply(t('admin.chatsList', { count: chats.length, lines: lines.join('\n') }));
}

// --- /chat <id> : full detail ----------------------------------------------

export async function cmdChat(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const id = parseChatId(args(ctx));
  if (id === null) {
    await ctx.reply(t('admin.chatUsage'));
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
          return tg
            ? t('admin.rosterLinked', { name: m.name, tg })
            : t('admin.rosterUnlinked', { name: m.name });
        })
        .join('\n')
    : t('admin.rosterEmpty');

  const memItems = listMemoryItemsForDisplay(id, loadConfig().MEMORY_HALFLIFE_DAYS);
  const memory = memItems.length
    ? memItems
        .map((it, i) => {
          const tag = it.scope === 'persona' ? '🎭 ' : it.pinned ? '📌 ' : '';
          const who = it.scope === 'user' && it.subject ? ` (→ ${it.subject})` : '';
          return `   ${i + 1}. ${tag}${it.content}${who}`;
        })
        .join('\n')
    : t('admin.empty');

  const slangCount = getLexicon(id).length;
  const slangLine = slangCount
    ? t('admin.slangLine', { count: slangCount, id })
    : t('admin.slangEmpty');

  const provider = cfg
    ? t('admin.providerConfigured', { name: cfg.provider_name, group: cfg.provider_group_id ?? '—' })
    : t('admin.providerNotConfigured');

  // Memory/roster are open-ended, so chunk to stay under Telegram's 4096 cap —
  // a large chat would otherwise 400 and look like the command did nothing.
  await replyLong(
    ctx,
    t('admin.chatDetail', {
      title: cfg?.title ?? t('admin.untitled'),
      id,
      provider,
      currency: cfg?.default_currency ?? loadConfig().DEFAULT_CURRENCY,
      roster,
      memory,
      slangLine,
    }),
  );
}

// --- /setgroup <id> <code> --------------------------------------------------

export async function cmdSetGroup(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, code] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !code) {
    await ctx.reply(t('admin.setGroupUsage'));
    return;
  }
  const provider = getProvider('splid');
  let groupId: string;
  try {
    groupId = (await provider.connect(code)).groupId;
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : String(err);
    await ctx.reply(t('admin.splidConnectFailed', { msg }));
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
  await ctx.reply(t('admin.setGroupOk', { id, count }));
}

// --- /setcurrency <id> <CUR> ------------------------------------------------

export async function cmdSetCurrency(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, cur] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !/^[A-Za-z]{3}$/.test(cur)) {
    await ctx.reply(t('admin.setCurrencyUsage'));
    return;
  }
  if (!getChatConfig(id)) {
    await ctx.reply(t('admin.chatNotConfigured', { id }));
    return;
  }
  setDefaultCurrency(id, cur);
  await ctx.reply(t('admin.setCurrencyOk', { id, cur: cur.toUpperCase() }));
}

// --- memory ----------------------------------------------------------------

export async function cmdSetMemory(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, text] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !text) {
    await ctx.reply(t('admin.setMemoryUsage'));
    return;
  }
  // "Replace" the chat's memory: wipe stored items and pin this one note.
  clearMemoryItems(id);
  insertPinned(id, text);
  await ctx.reply(t('admin.setMemoryOk', { id }));
}

export async function cmdAddMemory(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, text] = headTail(args(ctx));
  const id = parseChatId(idTok);
  if (id === null || !text) {
    await ctx.reply(t('admin.addMemoryUsage'));
    return;
  }
  insertPinned(id, text);
  await ctx.reply(t('admin.addMemoryOk', { id }));
}

export async function cmdClearMemory(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const id = parseChatId(args(ctx));
  if (id === null) {
    await ctx.reply(t('admin.clearMemoryUsage'));
    return;
  }
  clearMemoryItems(id);
  clearTurns(id);
  await ctx.reply(t('admin.clearMemoryOk', { id }));
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
    await ctx.reply(t('admin.personaUsage'));
    return;
  }
  // A bare integer targets an existing item by its /chat index; anything else is text.
  if (/^\d+$/.test(rest)) {
    const n = Number(rest);
    const items = listMemoryItemsForDisplay(id, loadConfig().MEMORY_HALFLIFE_DAYS);
    const target = items[n - 1];
    if (!target) {
      await ctx.reply(t('admin.noMemoryItem', { n, id }));
      return;
    }
    if (target.scope === 'persona') {
      await ctx.reply(t('admin.personaAlreadyStyle', { n }));
      return;
    }
    const moved = setItemScope(id, target.id, 'persona');
    await ctx.reply(t('admin.personaMoved', { id, content: moved ?? target.content }));
    return;
  }
  insertPinned(id, rest, { scope: 'persona' });
  await ctx.reply(t('admin.personaAdded', { id }));
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
    await ctx.reply(t('admin.editMemoryUsage'));
    return;
  }
  const items = listMemoryItemsForDisplay(id, loadConfig().MEMORY_HALFLIFE_DAYS);
  const target = items[n - 1];
  if (!target) {
    await ctx.reply(t('admin.noMemoryItem', { n, id }));
    return;
  }
  const old = editMemoryItemContent(id, target.id, text);
  await ctx.reply(t('admin.editMemoryOk', { n, id, old: old ?? target.content, text }));
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
    await ctx.reply(t('admin.reconcileUsage'));
    return;
  }

  if (rest.trim().toLowerCase() === 'apply') {
    const plan = pendingReconcile.get(id);
    if (!plan) {
      await ctx.reply(t('admin.reconcileNoPlan', { id }));
      return;
    }
    const { edited, deleted } = applyReconcilePlan(id, plan);
    pendingReconcile.delete(id);
    await ctx.reply(t('admin.reconcileApplied', { id, deleted, edited }));
    return;
  }

  const items = getAllItems(id);
  if (items.length === 0) {
    await ctx.reply(t('admin.reconcileEmpty', { id }));
    return;
  }
  await ctx.reply(t('admin.reconcileThinking'));
  const plan = await reconcileMemory(items);
  if (plan === null) {
    await ctx.reply(t('admin.reconcileAiFailed'));
    return;
  }
  if (plan.deletes.length === 0 && plan.edits.length === 0) {
    await ctx.reply(t('admin.reconcileNoConflicts'));
    return;
  }

  // Preview by CONTENT (not #id) so the admin reads exactly what would change.
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: string[] = [];
  for (const e of plan.edits) {
    const it = byId.get(e.id);
    if (it)
      lines.push(
        t('admin.reconcileEditLine', {
          old: it.content,
          new: e.content,
          reason: e.reason ? ` — ${e.reason}` : '',
        }),
      );
  }
  for (const d of plan.deletes) {
    const it = byId.get(d.id);
    if (it)
      lines.push(
        t('admin.reconcileDeleteLine', {
          content: it.content,
          reason: d.reason ? ` — ${d.reason}` : '',
        }),
      );
  }
  pendingReconcile.set(id, plan);
  await replyLong(
    ctx,
    t('admin.reconcilePreview', { id, count: lines.length, lines: lines.join('\n') }),
  );
}

/** `/dedupememory <chatId>` folds duplicate memory items into one pass. */
export async function cmdDedupeMemory(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const id = parseChatId(args(ctx));
  if (id === null) {
    await ctx.reply(t('admin.dedupeUsage'));
    return;
  }
  const removed = dedupeMemory(id, loadConfig().MEMORY_HALFLIFE_DAYS);
  await ctx.reply(
    removed > 0 ? t('admin.dedupeOk', { id, removed }) : t('admin.dedupeNone', { id }),
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
    await ctx.reply(t('admin.setLinkUsage'));
    return;
  }
  const cfg = getChatConfig(id);
  if (!cfg?.provider_group_id) {
    await ctx.reply(t('admin.chatNotLinked', { id }));
    return;
  }
  const members = await membersOf(cfg.provider_name, cfg.provider_group_id);
  const q = normalizeName(query);
  const member =
    members.find((m) => normalizeName(m.name) === q) ??
    members.find((m) => m.initials && normalizeName(m.initials) === q) ??
    members.find((m) => normalizeName(m.name).includes(q));
  if (!member) {
    await ctx.reply(t('admin.memberNotFound', { query, id }));
    return;
  }
  upsertMapping({
    chatId: id,
    tgUserId,
    providerMemberId: member.id,
    memberName: member.name,
  });
  await ctx.reply(t('admin.setLinkOk', { id, tgUserId, name: member.name }));
}

export async function cmdUnlink(ctx: Context): Promise<void> {
  if (!(await ensureAdminDM(ctx))) return;
  const [idTok, tgTok] = headTail(args(ctx));
  const id = parseChatId(idTok);
  const tgUserId = Number(tgTok);
  if (id === null || !Number.isInteger(tgUserId)) {
    await ctx.reply(t('admin.unlinkUsage'));
    return;
  }
  deleteMapping(id, tgUserId);
  await ctx.reply(t('admin.unlinkOk', { id, tgUserId }));
}
