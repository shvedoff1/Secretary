import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { getProvider } from '../../core/registry.js';
import { buildDraft } from '../../core/expenseService.js';
import type { Member, ExpenseDraft } from '../../core/types.js';
import { runAssistant, type AssistantResult } from '../../llm/assistant.js';
import { humorizeWithPreview, isHumorEnabled, classifyHumorDecision } from '../../llm/humorize.js';
import {
  applySlangOrOriginal,
  classifySlangDecision,
  isSlangPassEnabled,
} from '../../llm/slang.js';
import { isMoneyContext } from '../triggers.js';
import { toParsedExpense, type RecallMemoryInput } from '../../llm/schema.js';
import { makeSurfForecastHandler } from '../../surf/index.js';
import { makeDotaLookupHandler } from '../../dota/lookup.js';
import { makeSpendingReportHandler } from '../../spending/handler.js';
import { getChatConfig, setChatTitle } from '../../db/repos/chatConfig.repo.js';
import { getMapping } from '../../db/repos/memberMap.repo.js';
import {
  getMemoryForContext,
  searchMemory,
  memoryStats,
  insertPinned,
  findMemoryItemByText,
  editMemoryItemContent,
  removeMemoryItem,
} from '../../db/repos/memoryItem.repo.js';
import { addExpenseTerms } from '../../db/repos/expenseTerm.repo.js';
import { getVoiceLexicon, setGloss } from '../../db/repos/lexicon.repo.js';
import { addPoi, listPois } from '../../db/repos/poi.repo.js';
import { normalizeCategory } from '../../util/poi.js';
import {
  getTimezone,
  setTimezone,
  getChatMode,
  isChatHumorEnabled,
  isChatSlangEnabled,
} from '../../db/repos/chatSettings.repo.js';
import {
  createTask,
  listTasks,
  findDuplicate,
} from '../../db/repos/scheduledTask.repo.js';
import {
  createWatch,
  listWatches,
  findDuplicateWatch,
} from '../../db/repos/pageWatch.repo.js';
import {
  nextRunMs,
  isValidSchedule,
  isValidTimezone,
  formatInTimezone,
} from '../../util/schedule.js';
import type {
  ScheduleTaskInput,
  WatchPageInput,
  AddPoiInput,
  EditLexiconInput,
  EditPingListInput,
  EditMemoryInput,
} from '../../llm/schema.js';
import {
  DEFAULT_PING_LIST,
  addPingMembers,
  removePingMembers,
  getPingList,
  setMuteRules,
  addMuteRules,
  getMuteRules,
  clearMuteRules,
  renamePingMember,
} from '../../db/repos/pingList.repo.js';
import { parseHHMM, describeWindows, type MuteWindow } from '../../util/pingMute.js';
import { getAliasMap, setAlias } from '../../db/repos/nameAlias.repo.js';
import {
  addTurn,
  recentTurns,
  pruneOld,
} from '../../db/repos/conversation.repo.js';
import { presentDraft, prepareQuip, renderDraft, nameMapFromMembers } from './preview.js';
import { startTyping } from './typing.js';
import {
  getPending,
  updateDraft,
  type PendingSource,
} from '../../db/repos/pending.repo.js';
import { previewKeyboard } from '../keyboards.js';
import { sendRichMarkdown } from '../../util/richMessage.js';
import { looksLikeExpense } from '../../util/money.js';

/**
 * Handle the `remember` tool / explicit "запомни …": pin the note, but keep recorded
 * expenses out of memory — those belong in Splid. When `replaces` is given (a
 * correction/contradiction), the superseded facts are removed first so the new note
 * overrides them instead of coexisting. The "push back once before overriding" is the
 * model's job (prompt-driven); by the time this runs the override is already confirmed.
 */
export function rememberNote(chatId: number, note: string, replaces?: string[]): string {
  if (looksLikeExpense(note)) {
    return 'Это похоже на трату — такое в память не пишу, для трат есть Splid. Если это правда трата — просто скажи её как трату, я оформлю. 🤙';
  }
  // Resolve EVERY superseded fact against the current (unmutated) state first, then
  // remove — otherwise an earlier removal could turn a later `replaces` entry that was
  // safely ambiguous into a unique match and nuke an unrelated fact.
  const requested = replaces ?? [];
  const ids = new Set<number>();
  let unresolved = 0;
  for (const text of requested) {
    const match = findMemoryItemByText(chatId, text);
    if (match) ids.add(match.id);
    else unresolved++;
  }
  const removed: string[] = [];
  for (const id of ids) {
    const content = removeMemoryItem(chatId, id);
    if (content !== null) removed.push(content);
  }
  insertPinned(chatId, note);

  if (requested.length === 0) return 'Запомнил.';
  if (removed.length === 0) {
    // The override was asked for but nothing matched — say so, so a stale contradicting
    // fact doesn't silently survive alongside the new one under a "done" confirmation.
    return `Записал: ${note}. Но старое, что нужно было заменить, не нашёл — глянь /memory, могло остаться противоречие.`;
  }
  const tail = unresolved > 0 ? ' (часть старого не нашёл — глянь /memory)' : '';
  return `Обновил — заменил «${removed.join('», «')}»${tail}. Теперь у меня записано: ${note}`;
}

/**
 * Build the `edit_memory` handler for a chat: fix an existing remembered fact in place
 * (the "поправь/исправь в памяти …" flow). Matches the target fact forgivingly; if it
 * can't be pinned down, it says so rather than editing the wrong thing.
 */
export function makeEditMemoryHandler(chatId: number): (input: EditMemoryInput) => string {
  return ({ find, replace }) => {
    const match = findMemoryItemByText(chatId, find);
    if (!match) {
      return `Не нашёл в памяти «${find}». Глянь /memory — там точные формулировки, скажи какую менять.`;
    }
    editMemoryItemContent(chatId, match.id, replace);
    return `Поправил: «${match.content}» → «${replace.trim()}». 🤙`;
  };
}

/**
 * Build the `recall_memory` handler for a chat: the deep tier of memory. Every turn
 * carries a small weighted working set; this searches everything else on demand, so
 * the store can hold thousands of facts without any of them costing tokens until the
 * model actually reaches for one.
 *
 * The result is written for the model, not the user: each line carries its tier
 * (📌 pinned / 🎭 voice) and subject, so a recalled fact can be quoted with the right
 * confidence — and an empty result says so plainly, so "не помню" stays honest.
 */
export function makeRecallMemoryHandler(chatId: number): (input: RecallMemoryInput) => string {
  return ({ query, about }) => {
    const cfg = loadConfig();
    if (!cfg.ENABLE_MEMORY) return 'Память выключена — отвечай без неё.';
    const q = (query ?? '').trim();
    const who = (about ?? '').trim();
    if (!q && !who) {
      return 'Пустой запрос: передай `query` (что искать) и/или `about` (про кого).';
    }

    const hits = searchMemory(chatId, q, {
      about: who || null,
      limit: cfg.MEMORY_RECALL_LIMIT,
      halfLifeDays: cfg.MEMORY_HALFLIFE_DAYS,
    });
    const scope = who ? `про «${who}»${q ? ` по запросу «${q}»` : ''}` : `по запросу «${q}»`;
    if (hits.length === 0) {
      const { total } = memoryStats(chatId);
      return total === 0
        ? 'В памяти этого чата пока пусто — честно скажи, что не знаешь.'
        : `Ничего не нашёл ${scope} (в памяти ${total} записей). Попробуй другие слова — или честно скажи, что не помнишь, не выдумывай.`;
    }

    const lines = hits.map((h) => {
      const tag = h.item.scope === 'persona' ? '🎭 ' : h.item.source === 'explicit' ? '📌 ' : '';
      const subject = h.item.scope === 'user' && h.item.subject ? `[${h.item.subject}] ` : '';
      return `- ${tag}${subject}${h.item.content}`;
    });
    logger.debug({ chatId, query: q, about: who, hits: hits.length }, 'recall_memory served');
    return [
      `Нашёл в памяти ${scope} (${hits.length} записей, самое подходящее сверху):`,
      ...lines,
      'Это факты из памяти чата — используй их, но не выдумывай того, чего тут нет.',
    ].join('\n');
  };
}

export function senderName(ctx: Context): string {
  const u = ctx.from;
  if (!u) return 'someone';
  return (
    [u.first_name, u.last_name].filter(Boolean).join(' ') ||
    (u.username ? `@${u.username}` : `user ${u.id}`)
  );
}

// "Thinking" indicator: react to the message we're processing, then clear it once
// we're done. Reactions can fail (disabled in chat, missing rights) — never fatal.
const THINKING = '👀' as const;

async function setThinking(ctx: Context): Promise<void> {
  try {
    await ctx.react(THINKING);
  } catch {
    /* reactions are best-effort */
  }
}

async function clearThinking(ctx: Context): Promise<void> {
  try {
    await ctx.react([]);
  } catch {
    /* reactions are best-effort */
  }
}

/**
 * Send an assistant reply using Telegram's native rich-message formatting so the
 * model's markdown (tables, headings, lists, block quotes, inline styling) renders
 * properly. Degrades to the HTML subset and then plain text if rich messages aren't
 * available, so a reply is never lost.
 */
async function replyMarkdown(
  ctx: Context,
  text: string,
  extra: { reply_to_message_id?: number },
): Promise<void> {
  await sendRichMarkdown(ctx.api, ctx.chat!.id, text, {
    replyToMessageId: extra.reply_to_message_id,
  });
}

/**
 * When a correction resolves a name that was previously unrecognised, remember
 * the nickname → member mapping for next time. Only the unambiguous case (one
 * unresolved name before, one new member after) is learned.
 */
function learnAliasFromCorrection(
  chatId: number,
  oldDraft: ExpenseDraft,
  newDraft: ExpenseDraft,
  members: Member[],
): void {
  // Real unresolved names only (skip synthetic placeholders like "(плательщик…)").
  const oldNames = oldDraft.unresolved.filter((u) => !u.startsWith('('));
  if (oldNames.length !== 1) return;

  const idsOf = (d: ExpenseDraft): Set<string> =>
    new Set([...d.payers, ...d.profiteers].map((s) => s.memberId));
  const before = idsOf(oldDraft);
  const added = [...idsOf(newDraft)].filter((id) => !before.has(id));
  if (added.length !== 1) return;

  const member = members.find((m) => m.id === added[0]);
  if (!member) return;

  const alias = oldNames[0]!;
  try {
    setAlias(chatId, alias, member.id, member.name);
    insertPinned(chatId, `«${alias}» — это ${member.name}`);
    logger.info({ chatId, alias, member: member.name }, 'learned name alias');
  } catch (err) {
    logger.warn({ err }, 'failed to learn name alias');
  }
}

/**
 * Build the `schedule_task` handler for a chat: validates the model's cron +
 * timezone, persists the task, remembers the chat timezone (so we only ask once),
 * and returns a human confirmation the assistant relays back.
 */
export function makeScheduleTaskHandler(
  chatId: number,
  tgUserId: number,
  defaultTz: string,
): (input: ScheduleTaskInput) => string {
  return (input) => {
    const tz = isValidTimezone(input.timezone) ? input.timezone : defaultTz;
    if (!isValidSchedule(input.cron, tz)) {
      return 'Не понял расписание — уточни время (напр. «каждый день в 9 утра»).';
    }
    const next = nextRunMs(input.cron, tz);
    if (next === null) {
      return 'Это расписание уже не сработает — уточни время.';
    }
    setTimezone(chatId, tz);
    // Guard against re-creating a reminder that already exists (e.g. the original
    // request lingering in conversation history makes the model fire again).
    const dup = findDuplicate(listTasks(chatId), { cron: input.cron, title: input.title });
    if (dup) {
      return `Это уже стоит — #${dup.id} «${dup.title}» (следующий запуск ${formatInTimezone(dup.nextRunAt, dup.timezone)}).`;
    }
    const id = createTask({
      chatId,
      tgUserId,
      title: input.title,
      prompt: input.prompt,
      cron: input.cron,
      timezone: tz,
      once: input.once,
      humor: input.humor,
      nextRunAt: next,
    });
    const when = formatInTimezone(next, tz);
    const kind = input.once ? 'Напоминание' : 'Регулярная задача';
    const humorNote = input.humor ? ' 😂 с юмором' : '';
    return `${kind} #${id} «${input.title}»${humorNote} создана. Первый запуск: ${when} (${tz}). Список: /tasks`;
  };
}

/**
 * Build the `watch_page` handler for a chat — the «следи за страницей и напиши,
 * когда появятся сеансы» flow. Validates the model's input, clamps the pace and
 * lifetime to sane bounds, guards against duplicates and a per-chat cap, arms the
 * watch (first poll on the next runner tick), and returns a human confirmation.
 */
export function makeWatchPageHandler(
  chatId: number,
  tgUserId: number,
): (input: WatchPageInput) => string {
  return (input) => {
    const cfg = loadConfig();
    if (!/^https?:\/\//i.test(input.url)) {
      return 'Могу следить только за обычными http(s)-страницами — дай прямую ссылку.';
    }
    const keywords = [
      ...new Set(input.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean)),
    ];
    if (keywords.length === 0) {
      return 'Не понял, какие слова искать на странице — уточни, что именно должно появиться.';
    }
    const active = listWatches(chatId);
    const dup = findDuplicateWatch(active, { url: input.url, condition: input.condition });
    if (dup) {
      return `Уже слежу — вотчер #${dup.id} «${dup.title}». Список: /watch`;
    }
    if (active.length >= cfg.WATCH_MAX_PER_CHAT) {
      return `В этом чате уже ${active.length} активных вотчеров — это потолок. Сними лишний: /watch del <id> (список: /watch)`;
    }
    const interval = Math.min(
      Math.max(input.intervalMinutes ?? cfg.WATCH_INTERVAL_MINUTES, 5),
      24 * 60,
    );
    const days = Math.min(Math.max(input.expiresInDays ?? cfg.WATCH_EXPIRES_DAYS, 1), 90);
    const now = Date.now();
    const expiresAt = now + days * 24 * 60 * 60_000;
    const id = createWatch({
      chatId,
      tgUserId,
      title: input.title,
      url: input.url,
      condition: input.condition,
      keywords,
      intervalMinutes: interval,
      expiresAt,
      // Due immediately: the runner's next minute tick does the first poll.
      nextCheckAt: now,
    });
    const until = formatInTimezone(expiresAt, getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE);
    return (
      `👁 Вотчер #${id} «${input.title}» поставлен: проверяю страницу каждые ${interval} мин ` +
      `(слежу до ${until}). Как появится — сразу напишу сюда. Список: /watch`
    );
  };
}

/**
 * Build the `learn_expense_pattern` handler for a chat: persists the taught
 * trigger words into the chat's expense dictionary and returns a short human
 * confirmation. Future messages containing a stored term (with a number) will
 * auto-route as expenses — no redeploy needed.
 */
export function makeLearnExpenseHandler(
  chatId: number,
  tgUserId: number,
): (input: { keywords: string[] }) => string {
  return (input) => {
    const added = addExpenseTerms(chatId, input.keywords, tgUserId);
    if (added.length === 0) {
      return 'Уже знаю такие слова — ничего нового не добавил.';
    }
    const list = added.map((t) => `«${t}»`).join(', ');
    return `Запомнил: сообщения со словами ${list} теперь считаю тратами. Список: /trata`;
  };
}

/**
 * Build the `edit_lexicon` handler for a chat: corrects the meaning of a learned
 * slang word (the "поменяй значение у X на Y" flow) and returns a short
 * confirmation. Never creates a new word — only fixes an existing one's meaning.
 */
export function makeEditLexiconHandler(
  chatId: number,
): (input: EditLexiconInput) => string {
  return ({ term, gloss }) => {
    const res = setGloss(chatId, term, gloss);
    return res.updated
      ? `Готово — «${res.term}» теперь значит «${gloss.trim()}». 🤙`
      : `Не нашёл «${term.trim()}» в словечках чата. Глянь /slang — там точные формы.`;
  };
}

/**
 * Build the `edit_ping_list` handler for a chat — the "добавь @vasya в основной
 * пинг" flow. Adds/removes members on a /ping roster and returns a short
 * confirmation. Names in the confirmation are given WITHOUT the @ so the model's
 * reply can't accidentally ping the people it just talks about.
 */
export function makeEditPingListHandler(
  chatId: number,
  tgUserId: number,
): (input: EditPingListInput) => string {
  return ({ action, list, members, mute, timezone, replace, renameTo }) => {
    const name = list?.trim().toLowerCase() || DEFAULT_PING_LIST;
    const plain = (xs: string[]) => xs.map((m) => m.replace(/^@/, '')).join(', ');
    const pingCmd = name === DEFAULT_PING_LIST ? '/ping' : `/ping ${name}`;

    // Fix a stored mention («исправь меншн X на Y»): the token is renamed in
    // EVERY list of the chat and the member's quiet-hours rules move along.
    if (action === 'rename') {
      const to = renameTo?.trim();
      if (!to) {
        return 'Не понял, на какой ник менять — скажи «исправь меншн X на @новый_ник».';
      }
      const from = members[0]!;
      const res = renamePingMember(chatId, from, to);
      if (res.entries === 0 && res.rulesMoved === 0) {
        return `Не нашёл «${plain([from])}» ни в одном списке. Составы: /ping lists`;
      }
      const rulesNote =
        res.rulesMoved > 0 ? `, правила тишины переехали (${res.rulesMoved})` : '';
      return `Поправил: ${plain([from])} → ${plain([to])} (записей: ${res.entries}${rulesNote}). Проверка: /ping show`;
    }

    // Personal quiet hours («не тегай меня до 19:00 по будням»). Whether the
    // windows replace the member's schedule (a full restatement/correction) or
    // extend it («ещё не тегай в субботу») is the model's call via `replace`;
    // absent → append, because appending preserves data and replacing destroys
    // it. Times default to Moscow per product decision.
    if (action === 'mute') {
      const windows = mute ?? [];
      if (windows.length === 0) {
        return 'Не понял окна тишины — скажи, в какие дни и часы не тегать.';
      }
      const tz = timezone && isValidTimezone(timezone) ? timezone : 'Europe/Moscow';
      const parsed: MuteWindow[] = [];
      for (const w of windows) {
        const fromMin = parseHHMM(w.from);
        const toMin = parseHHMM(w.to);
        if (fromMin === null || toMin === null || fromMin === toMin) {
          return `Не понял время «${w.from}–${w.to}» — уточни часы (напр. «до 19:00», «с 18 до 21»).`;
        }
        parsed.push({ days: w.days, fromMin, toMin, timezone: tz });
      }
      const overwrite = replace === true;
      for (const m of members) {
        if (overwrite) setMuteRules(chatId, m, parsed);
        else addMuteRules(chatId, m, parsed);
      }
      // Confirm with the member's RESULTING schedule (not just the delta), so
      // append vs replace is transparent to the user either way.
      const total = describeWindows(getMuteRules(chatId, members[0]!));
      const verb = overwrite ? 'Переписал расписание' : 'Дополнил расписание';
      return `${verb}: ${plain(members)} — теперь не тревожим ${total}. В остальное время пингуется как все. Снять всё: скажи «можно снова тегать». Проверка: /ping show`;
    }
    if (action === 'unmute') {
      const cleared = members.filter((m) => clearMuteRules(chatId, m) > 0);
      return cleared.length > 0
        ? `Снял беззвучное: ${plain(cleared)} — теперь тегается всегда.`
        : `У ${plain(members)} и не было окон тишины.`;
    }

    if (action === 'add') {
      const added = addPingMembers(chatId, name, members, tgUserId);
      const total = getPingList(chatId, name).length;
      if (added.length === 0) {
        return `Все названные уже в составе «${name}» (${total} чел.). Глянуть: /ping show${name === DEFAULT_PING_LIST ? '' : ` ${name}`}`;
      }
      return `Добавил в «${name}»: ${plain(added)}. Теперь в составе ${total}. Пинг: ${pingCmd}`;
    }
    const removed = removePingMembers(chatId, name, members);
    if (removed.length === 0) {
      return `Никого из названных в списке «${name}» не нашёл. Состав: /ping show${name === DEFAULT_PING_LIST ? '' : ` ${name}`}`;
    }
    const total = getPingList(chatId, name).length;
    return `Убрал из «${name}»: ${plain(removed)}. Осталось ${total}.`;
  };
}

/**
 * Build the `add_poi` handler for a chat: persists the place and returns a short
 * human confirmation the assistant relays back.
 */
export function makeAddPoiHandler(
  chatId: number,
  tgUserId: number,
): (input: AddPoiInput) => string {
  return (input) => {
    const poi = addPoi({
      chatId,
      tgUserId,
      name: input.name,
      category: normalizeCategory(input.category),
      description: input.description,
      address: input.address,
      latitude: input.latitude,
      longitude: input.longitude,
    });
    return `Добавил в места: ${poi.name}. Список: /poi`;
  };
}

/**
 * What `runAndRespond` did with a message, so callers (e.g. the voice handler)
 * can react accordingly: an expense was drafted, a text reply was sent, nothing
 * was sent (silent auto-expense scan), or the assistant call failed.
 */
export type RespondOutcome = 'expense' | 'replied' | 'silent' | 'error';

interface RunArgs {
  userContent: string | Anthropic.ContentBlockParam[];
  addressed: boolean;
  source: PendingSource;
  /** Plain text used for conversation history (e.g. caption or message text). */
  historyText: string;
  /**
   * Manage the "thinking" reaction (👀 set while working, cleared when done).
   * Defaults to true. Callers that own the message reaction themselves (the
   * voice handler keeps a ✍️ on recorded expenses) pass false.
   */
  manageReaction?: boolean;
}

/**
 * Run the LLM assistant for a message and act on the result:
 * expense → preview; text → reply (unless this was a silent auto-expense scan).
 * Returns what happened so callers can adjust their own UI (reactions, etc.).
 */
export async function runAndRespond(ctx: Context, args: RunArgs): Promise<RespondOutcome> {
  const manageReaction = args.manageReaction ?? true;
  if (manageReaction) await setThinking(ctx);
  // Show "печатает…" while we generate, but only when we'll actually reply
  // (addressed). A silent auto-expense scan must stay invisible — no typing there.
  const typing = args.addressed ? startTyping(ctx) : null;
  try {
    return await runAndRespondInner(ctx, args);
  } finally {
    typing?.stop();
    if (manageReaction) await clearThinking(ctx);
  }
}

async function runAndRespondInner(ctx: Context, args: RunArgs): Promise<RespondOutcome> {
  const cfg = loadConfig();
  const chatId = ctx.chat!.id;
  const tgUserId = ctx.from!.id;

  const chatCfg = getChatConfig(chatId);
  if (chatCfg && ctx.chat?.type !== 'private' && ctx.chat && 'title' in ctx.chat && ctx.chat.title) {
    setChatTitle(chatId, ctx.chat.title);
  }

  // Load the member roster (for name resolution + context) if configured.
  let members: Member[] = [];
  if (chatCfg?.provider_group_id) {
    try {
      members = await getProvider(chatCfg.provider_name).listMembers({
        groupId: chatCfg.provider_group_id,
      });
    } catch (err) {
      logger.warn({ err }, 'could not load members for context');
    }
  }

  const history = recentTurns(
    chatId,
    cfg.CONVERSATION_HISTORY_LIMIT,
    cfg.CONVERSATION_HISTORY_MAX_AGE_HOURS * 60 * 60 * 1000,
  );

  // Other people active in the recent conversation, so we can surface a fact or two
  // about each of them too (not just the current sender).
  const recentParticipantIds = [
    ...new Set(
      history
        .filter((t) => t.role === 'user' && t.tgUserId !== null)
        .map((t) => t.tgUserId as number),
    ),
  ];
  const memorySel = getMemoryForContext(chatId, {
    senderTgUserId: tgUserId,
    recentParticipantIds,
    halfLifeDays: cfg.MEMORY_HALFLIFE_DAYS,
    chatBudget: cfg.MEMORY_CONTEXT_CHAT,
    userBudget: cfg.MEMORY_CONTEXT_USER,
    pinnedChatBudget: cfg.MEMORY_CONTEXT_PINNED,
    otherUserBudget: cfg.MEMORY_CONTEXT_OTHER,
    maxOtherUsers: cfg.MEMORY_CONTEXT_MAX_OTHERS,
    personaBudget: cfg.MEMORY_CONTEXT_PERSONA,
  });

  const mode = getChatMode(chatId);
  let result: AssistantResult;
  try {
    result = await runAssistant(
      {
        mode,
        defaultCurrency: chatCfg?.default_currency ?? cfg.DEFAULT_CURRENCY,
        members: members.map((m) => ({ name: m.name, initials: m.initials })),
        memoryChat: memorySel.chat.map((i) => ({ content: i.content })),
        memoryUsers: memorySel.users.map((u) => ({
          subject: u.subject,
          items: u.items.map((i) => ({ content: i.content })),
        })),
        memoryPersona: memorySel.persona.map((i) => ({ content: i.content })),
        // Total held, so the context block can tell the model how much is NOT shown
        // and that recall_memory reaches the rest.
        memoryTotal: memoryStats(chatId).total,
        senderName: senderName(ctx),
        senderUsername: ctx.from?.username ?? null,
        timezone: getTimezone(chatId),
        splidConnected: !!chatCfg?.provider_group_id,
        activeReminders: listTasks(chatId).map((t) => ({
          id: t.id,
          title: t.title,
          when: (t.once ? 'разово ' : '') + formatInTimezone(t.nextRunAt, t.timezone),
        })),
        activeWatches: listWatches(chatId).map((w) => ({
          id: w.id,
          title: w.title,
          url: w.url,
        })),
        places: listPois(chatId).map((p) => ({ name: p.name, category: p.category })),
        history,
        userContent: args.userContent,
      },
      {
        remember: (input) => rememberNote(chatId, input.note, input.replaces),
        editMemory: makeEditMemoryHandler(chatId),
        recallMemory: makeRecallMemoryHandler(chatId),
        learnExpense: makeLearnExpenseHandler(chatId, tgUserId),
        editLexicon: makeEditLexiconHandler(chatId),
        editPingList: makeEditPingListHandler(chatId, tgUserId),
        scheduleTask: makeScheduleTaskHandler(chatId, tgUserId, cfg.DEFAULT_TIMEZONE),
        watchPage: makeWatchPageHandler(chatId, tgUserId),
        dotaLookup: makeDotaLookupHandler(),
        surfForecast: makeSurfForecastHandler(),
        addPoi: makeAddPoiHandler(chatId, tgUserId),
        spendingReport: makeSpendingReportHandler(chatId),
      },
    );
  } catch (err) {
    logger.error({ err }, 'assistant call failed');
    if (args.addressed) {
      const status = (err as { status?: number })?.status;
      const overloaded = status === 529 || status === 503 || status === 429;
      await ctx.reply(
        overloaded
          ? '⚠️ ИИ сейчас перегружен (529). Я уже несколько раз перепробовал — дай ему минутку и повтори. 🤙'
          : '⚠️ Не получилось обратиться к ИИ. Попробуй ещё раз чуть позже.',
      );
    }
    return 'error';
  }

  if (result.kind === 'expense') {
    if (!chatCfg?.provider_group_id) {
      await ctx.reply(
        'Чтобы записывать траты в Splid, подключи группу: /group <код-приглашения>. ' +
          'Это опционально — без него я и так помогу: напоминания, поиск, заметки. 🤙',
      );
      return 'replied';
    }
    const senderMapping = getMapping(chatId, tgUserId);
    // The model may have split a receipt into several per-group expenses. Show
    // its breakdown explanation once (if any), then a separate preview for each
    // expense so every group can be confirmed/edited on its own.
    if (result.preamble) {
      await replyMarkdown(ctx, result.preamble, {
        reply_to_message_id: ctx.message?.message_id,
      });
    }
    for (const input of result.inputs) {
      const draft = buildDraft({
        parsed: toParsedExpense(input),
        members,
        senderMemberId: senderMapping?.provider_member_id ?? null,
        defaultCurrency: chatCfg.default_currency,
        aliases: getAliasMap(chatId),
      });
      await presentDraft(ctx, {
        chatId,
        tgUserId,
        draft,
        source: args.source,
        members,
      });
    }
    // Expenses are a side-channel (preview/confirm), NOT dialogue — keep them out
    // of conversation history so the assistant doesn't resurface old expenses on
    // unrelated messages.
    return 'expense';
  }

  // Text result. For a silent auto-expense scan that produced no expense, stay quiet
  // and record nothing.
  if (!args.addressed) {
    return 'silent';
  }

  // For a plain-chat answer (no tool used), optionally run the tone-only
  // humorizer. It's best-effort: disabled or failed → original text unchanged,
  // so accuracy and delivery are never at risk. The "is this safe to humorize"
  // decision is made from the INPUT, never the generated reply: tool/factual
  // answers are excluded by `humorizable` (the model already chose a tool), and
  // money is judged from the user's message + receipt photos. We don't re-scan
  // the bot's own prose — it riffs with stray numbers and would muzzle its jokes.
  // When the humorizer runs, the pre-OpenAI original is DM'd to the admin so the
  // before/after can be compared.
  const money = isMoneyContext({
    source: args.source,
    userText: args.historyText,
    chatId,
  });
  const decision = classifyHumorDecision({
    // The humorizer runs only when it's on globally AND not switched off for
    // THIS chat (/humor <chatId> off) — a silenced chat gets Claude's text as-is.
    enabled: isHumorEnabled() && isChatHumorEnabled(chatId),
    humorizable: result.humorizable ?? false,
    money,
  });
  // One line per addressed reply explaining whether it reached OpenAI and why
  // not — makes "почему не поехало в openai" diagnosable from logs instead of
  // guessing which gate fired.
  logger.info(
    { decision, humorizable: result.humorizable ?? false, money, source: args.source },
    'humorizer gate',
  );
  const safeToHumorize = decision === 'sent';
  // The chat's learned slang never reaches Claude (it saw clean history/context)
  // — it is applied here, at the tone pass. `getVoiceLexicon` honours the
  // per-chat slang switch, so /slang off empties it for BOTH passes below.
  const lexicon = getVoiceLexicon(chatId, cfg.LEXICON_MAX_TERMS);
  const humorized = safeToHumorize
    ? await humorizeWithPreview(
        result.text,
        async (original) => {
          await ctx.api.sendMessage(cfg.ADMIN_TELEGRAM_ID, `🔬 До OpenAI:\n\n${original}`);
        },
        lexicon,
        // The tone pass must speak the chat's persona: a dota chat gets the
        // schoolkid-sensei rewrite, not the surfer one.
        mode === 'dota' ? 'dota' : 'surfer',
      )
    : result.text;

  // Everything the humorizer is banned from — tool/factual answers, money
  // answers, chats with the jokes switched off — still gets the chat's WORDS,
  // just not its jokes: the slang pass swaps vocabulary only and drops the
  // rewrite if any number/link/@handle moved. So an exact answer speaks the
  // group's lingo without its facts being at risk. Tutor chats stay clean.
  const slangDecision = classifySlangDecision({
    enabled: isSlangPassEnabled() && isChatSlangEnabled(chatId) && mode !== 'tutor',
    humorized: safeToHumorize,
    toned: result.toned ?? false,
    lexiconSize: lexicon.length,
  });
  logger.info({ decision: slangDecision, source: args.source }, 'slang gate');
  const replyText =
    slangDecision === 'sent' ? await applySlangOrOriginal(humorized, lexicon) : humorized;

  await replyMarkdown(ctx, replyText, {
    reply_to_message_id: ctx.message?.message_id,
  });
  // A reminder request is a completed side-action, not dialogue — keep it out of
  // history so it can't replay and re-create the reminder on a later message.
  if (result.scheduled) return 'replied';
  // Record this conversational exchange (and only this) for future context.
  // Store what we actually sent (the humorized text) so history matches the chat.
  addTurn({ chatId, role: 'user', tgUserId, senderName: senderName(ctx), content: args.historyText });
  addTurn({ chatId, role: 'assistant', tgUserId: null, content: replyText });
  pruneOld(chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
  return 'replied';
}

/**
 * Re-parse a correction (a reply to a preview message) and update the existing
 * pending draft in place, editing the original preview message.
 */
export async function rewordPending(
  ctx: Context,
  pendingId: string,
  previewMessageId: number,
  correctionText: string,
): Promise<void> {
  await setThinking(ctx);
  const typing = startTyping(ctx);
  try {
    await rewordPendingInner(ctx, pendingId, previewMessageId, correctionText);
  } finally {
    typing.stop();
    await clearThinking(ctx);
  }
}

async function rewordPendingInner(
  ctx: Context,
  pendingId: string,
  previewMessageId: number,
  correctionText: string,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const tgUserId = ctx.from!.id;
  const pending = getPending(pendingId);
  if (!pending || pending.status !== 'awaiting') {
    await ctx.reply('Это превью уже неактивно.');
    return;
  }

  const cfg = loadConfig();
  const chatCfg = getChatConfig(chatId);
  if (!chatCfg?.provider_group_id) {
    await ctx.reply('Сначала подключите группу Splid командой /group.');
    return;
  }

  let members: Member[] = [];
  try {
    members = await getProvider(chatCfg.provider_name).listMembers({
      groupId: chatCfg.provider_group_id,
    });
  } catch (err) {
    logger.warn({ err }, 'could not load members for reword');
  }

  // Give the model the current draft so a SHORT correction ("это Миша", "сумма
  // 700", "дели на всех") is applied incrementally instead of being re-parsed
  // from scratch (which would fail to look like a standalone expense).
  const currentSummary = renderDraft(pending.draft, nameMapFromMembers(members));
  const correctionContent =
    `Это ответ на превью уже распознанной траты. Текущее превью:\n${currentSummary}\n\n` +
    `Если это ПРАВКА траты — применни её и верни ПОЛНУЮ трату через record_expense ` +
    `(сумма, валюта, кто платил, на кого делим). Если в превью или заметках (📝) ` +
    `перечислены позиции с ценами, а пользователь говорит кто что ел/заказал — ` +
    `посчитай неравное деление сам (splits с суммой на каждого) из этих цен и НЕ ` +
    `проси цены, которые уже известны. НО если это вообще не про трату, а отдельный ` +
    `вопрос или просьба (напр. «обнови прогноз», «откуда ты это взял») — просто ответь ` +
    `на него (можно другим инструментом), не выдумывай трату. Сообщение: "${correctionText}"`;

  const result = await runAssistant(
    {
      defaultCurrency: chatCfg.default_currency,
      members: members.map((m) => ({ name: m.name, initials: m.initials })),
      senderName: senderName(ctx),
      timezone: getTimezone(chatId),
      splidConnected: !!chatCfg.provider_group_id,
      history: [],
      userContent: correctionContent,
    },
    {
      remember: (input) => rememberNote(chatId, input.note, input.replaces),
      editMemory: makeEditMemoryHandler(chatId),
      recallMemory: makeRecallMemoryHandler(chatId),
      learnExpense: makeLearnExpenseHandler(chatId, tgUserId),
      editLexicon: makeEditLexiconHandler(chatId),
      editPingList: makeEditPingListHandler(chatId, tgUserId),
      scheduleTask: makeScheduleTaskHandler(chatId, tgUserId, cfg.DEFAULT_TIMEZONE),
      watchPage: makeWatchPageHandler(chatId, tgUserId),
      dotaLookup: makeDotaLookupHandler(),
      surfForecast: makeSurfForecastHandler(),
      addPoi: makeAddPoiHandler(chatId, tgUserId),
      spendingReport: makeSpendingReportHandler(chatId),
    },
  );

  // The reply to a preview usually corrects the trade — but it may turn out to be a
  // different request entirely (a question, a surf forecast, «откуда ты это берешь»).
  // If the model answered instead of returning an expense, deliver that answer rather
  // than dead-ending with "Не понял правку" — the reword flow is a graceful superset,
  // not an expense-only trap.
  if (result.kind !== 'expense') {
    await replyMarkdown(ctx, result.text, {
      reply_to_message_id: ctx.message?.message_id,
    });
    return;
  }
  // A reword corrects ONE existing preview in place, so we apply just the first
  // expense the model returns (it's told to return the whole trade as one).
  const rewordInput = result.inputs[0];
  if (!rewordInput) {
    await ctx.reply(
      'Не понял правку. Можешь переписать трату целиком, напр.: «такси 500 за меня и Колю».',
    );
    return;
  }

  const senderMapping = getMapping(chatId, tgUserId);
  const draft = buildDraft({
    parsed: toParsedExpense(rewordInput),
    members,
    senderMemberId: senderMapping?.provider_member_id ?? null,
    defaultCurrency: chatCfg.default_currency,
    aliases: getAliasMap(chatId),
  });
  updateDraft(pendingId, draft);
  // The reword may have changed the title — refresh the pre-generated joke so the
  // confirmation still matches what was bought.
  prepareQuip(pendingId, draft.title, chatId);

  // Learn the nickname: if the previous draft had exactly one unresolved name
  // and this correction resolved exactly one new member, remember that mapping
  // (both as a fast lookup and a human-readable note in chat memory).
  learnAliasFromCorrection(chatId, pending.draft, draft, members);

  const text = renderDraft(
    draft,
    nameMapFromMembers(members),
    members.map((m) => m.name),
  );
  try {
    await ctx.api.editMessageText(chatId, previewMessageId, text, {
      reply_markup: previewKeyboard(pendingId),
    });
  } catch {
    await presentDraft(ctx, {
      chatId,
      tgUserId,
      draft,
      source: 'text',
      members,
    });
  }
}
