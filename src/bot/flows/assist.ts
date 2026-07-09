import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { getProvider } from '../../core/registry.js';
import { buildDraft } from '../../core/expenseService.js';
import type { Member, ExpenseDraft } from '../../core/types.js';
import { runAssistant, type AssistantResult } from '../../llm/assistant.js';
import { humorizeWithPreview, isHumorEnabled, classifyHumorDecision } from '../../llm/humorize.js';
import { isMoneyContext } from '../triggers.js';
import { toParsedExpense } from '../../llm/schema.js';
import { makeSurfForecastHandler } from '../../surf/index.js';
import { makeSpendingReportHandler } from '../../spending/handler.js';
import { getChatConfig, setChatTitle } from '../../db/repos/chatConfig.repo.js';
import { getMapping } from '../../db/repos/memberMap.repo.js';
import {
  getMemoryForContext,
  insertPinned,
  findMemoryItemByText,
  editMemoryItemContent,
  removeMemoryItem,
} from '../../db/repos/memoryItem.repo.js';
import { addExpenseTerms } from '../../db/repos/expenseTerm.repo.js';
import { getLexicon, setGloss } from '../../db/repos/lexicon.repo.js';
import { addPoi, listPois } from '../../db/repos/poi.repo.js';
import { normalizeCategory } from '../../util/poi.js';
import { getTimezone, setTimezone, getPersonaId } from '../../db/repos/chatSettings.repo.js';
import { personaStyleFor } from '../../llm/prompts.js';
import {
  createTask,
  listTasks,
  findDuplicate,
} from '../../db/repos/scheduledTask.repo.js';
import {
  nextRunMs,
  isValidSchedule,
  isValidTimezone,
  formatInTimezone,
} from '../../util/schedule.js';
import type {
  ScheduleTaskInput,
  AddPoiInput,
  EditLexiconInput,
  EditMemoryInput,
} from '../../llm/schema.js';
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
import { t } from '../../i18n/index.js';

/**
 * Handle the `remember` tool / explicit "запомни …": pin the note, but keep recorded
 * expenses out of memory — those belong in Splid. When `replaces` is given (a
 * correction/contradiction), the superseded facts are removed first so the new note
 * overrides them instead of coexisting. The "push back once before overriding" is the
 * model's job (prompt-driven); by the time this runs the override is already confirmed.
 */
export function rememberNote(chatId: number, note: string, replaces?: string[]): string {
  if (looksLikeExpense(note)) {
    return t('assist.looksLikeExpense');
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

  if (requested.length === 0) return t('assist.remembered');
  if (removed.length === 0) {
    // The override was asked for but nothing matched — say so, so a stale contradicting
    // fact doesn't silently survive alongside the new one under a "done" confirmation.
    return t('assist.rememberedNoMatch', { note });
  }
  const tail = unresolved > 0 ? t('assist.rememberedTail') : '';
  return t('assist.rememberedReplaced', { removed: removed.join('», «'), tail, note });
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
      return t('assist.editMemoryNotFound', { find });
    }
    editMemoryItemContent(chatId, match.id, replace);
    return t('assist.editMemoryDone', { content: match.content, replace: replace.trim() });
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
      return t('assist.scheduleBadCron');
    }
    const next = nextRunMs(input.cron, tz);
    if (next === null) {
      return t('assist.scheduleInPast');
    }
    setTimezone(chatId, tz);
    // Guard against re-creating a reminder that already exists (e.g. the original
    // request lingering in conversation history makes the model fire again).
    const dup = findDuplicate(listTasks(chatId), { cron: input.cron, title: input.title });
    if (dup) {
      return t('assist.scheduleDuplicate', {
        id: dup.id,
        title: dup.title,
        when: formatInTimezone(dup.nextRunAt, dup.timezone),
      });
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
    const kind = input.once ? t('assist.taskKindOnce') : t('assist.taskKindRecurring');
    const humorNote = input.humor ? t('assist.taskHumorNote') : '';
    return t('assist.taskCreated', {
      kind,
      id,
      title: input.title,
      humorNote,
      when,
      tz,
    });
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
      return t('assist.learnExpenseNothingNew');
    }
    const list = added.map((term) => `«${term}»`).join(', ');
    return t('assist.learnExpenseDone', { list });
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
      ? t('assist.editLexiconDone', { term: res.term, gloss: gloss.trim() })
      : t('assist.editLexiconNotFound', { term: term.trim() });
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
    return t('assist.poiAdded', { name: poi.name });
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

  let result: AssistantResult;
  try {
    result = await runAssistant(
      {
        defaultCurrency: chatCfg?.default_currency ?? cfg.DEFAULT_CURRENCY,
        members: members.map((m) => ({ name: m.name, initials: m.initials })),
        memoryChat: memorySel.chat.map((i) => ({ content: i.content })),
        memoryUsers: memorySel.users.map((u) => ({
          subject: u.subject,
          items: u.items.map((i) => ({ content: i.content })),
        })),
        memoryPersona: memorySel.persona.map((i) => ({ content: i.content })),
        personaStyle: personaStyleFor(getPersonaId(chatId) ?? cfg.DEFAULT_PERSONA),
        senderName: senderName(ctx),
        timezone: getTimezone(chatId),
        splidConnected: !!chatCfg?.provider_group_id,
        activeReminders: listTasks(chatId).map((t) => ({
          id: t.id,
          title: t.title,
          when: (t.once ? 'разово ' : '') + formatInTimezone(t.nextRunAt, t.timezone),
        })),
        places: listPois(chatId).map((p) => ({ name: p.name, category: p.category })),
        history,
        userContent: args.userContent,
      },
      {
        remember: (input) => rememberNote(chatId, input.note, input.replaces),
        editMemory: makeEditMemoryHandler(chatId),
        learnExpense: makeLearnExpenseHandler(chatId, tgUserId),
        editLexicon: makeEditLexiconHandler(chatId),
        scheduleTask: makeScheduleTaskHandler(chatId, tgUserId, cfg.DEFAULT_TIMEZONE),
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
        overloaded ? t('assist.aiOverloaded') : t('assist.aiError'),
      );
    }
    return 'error';
  }

  if (result.kind === 'expense') {
    if (!chatCfg?.provider_group_id) {
      await ctx.reply(t('assist.connectSplid'));
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
    enabled: isHumorEnabled(),
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
  // The chat's learned slang now rides ONLY on the humorizer (OpenAI) — Claude
  // saw clean history/context. So the chat's voice is applied here, at the tone
  // pass, not in the factual answer.
  const replyText = safeToHumorize
    ? await humorizeWithPreview(
        result.text,
        async (original) => {
          await ctx.api.sendMessage(cfg.ADMIN_TELEGRAM_ID, t('assist.beforeOpenAi', { text: original }));
        },
        getLexicon(chatId, cfg.LEXICON_MAX_TERMS).map((e) => ({ term: e.term, gloss: e.gloss })),
      )
    : result.text;

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
    await ctx.reply(t('assist.previewInactive'));
    return;
  }

  const cfg = loadConfig();
  const chatCfg = getChatConfig(chatId);
  if (!chatCfg?.provider_group_id) {
    await ctx.reply(t('assist.connectSplidReword'));
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
      personaStyle: personaStyleFor(getPersonaId(chatId) ?? cfg.DEFAULT_PERSONA),
      senderName: senderName(ctx),
      timezone: getTimezone(chatId),
      splidConnected: !!chatCfg.provider_group_id,
      history: [],
      userContent: correctionContent,
    },
    {
      remember: (input) => rememberNote(chatId, input.note, input.replaces),
      editMemory: makeEditMemoryHandler(chatId),
      learnExpense: makeLearnExpenseHandler(chatId, tgUserId),
      editLexicon: makeEditLexiconHandler(chatId),
      scheduleTask: makeScheduleTaskHandler(chatId, tgUserId, cfg.DEFAULT_TIMEZONE),
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
    await ctx.reply(t('assist.rewordNotUnderstood'));
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
  prepareQuip(pendingId, draft.title);

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
