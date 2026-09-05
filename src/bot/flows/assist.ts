import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { getProvider } from '../../core/registry.js';
import { buildDraft } from '../../core/expenseService.js';
import type { Member, ExpenseDraft } from '../../core/types.js';
import { runAssistant, type AssistantResult } from '../../llm/assistant.js';
import {
  humorizeWithPreview,
  isHumorEnabled,
  classifyHumorDecision,
  humorPersonaForMode,
} from '../../llm/humorize.js';
import {
  applySlangOrOriginal,
  classifySlangDecision,
  isSlangPassEnabled,
} from '../../llm/slang.js';
import { isExpenseShaped, isMoneyContext } from '../triggers.js';
import { toParsedExpense, type RecallMemoryInput } from '../../llm/schema.js';
import { makeSurfForecastHandler } from '../../surf/index.js';
import { makeDotaLookupHandler } from '../../dota/lookup.js';
import { makeSpendingReportHandler } from '../../spending/handler.js';
import { makeSummarizeChatHandler } from '../../summary/handler.js';
import {
  makeCalendarEventsHandler,
  upcomingCalendarLines,
  calendarConnected,
} from '../../calendar/handler.js';
import { recordChatLog } from '../chatLog.js';
import { getChatConfig, setChatTitle } from '../../db/repos/chatConfig.repo.js';
import { botAdminLabels } from '../permissions.js';
import { getMapping } from '../../db/repos/memberMap.repo.js';
import {
  getMemoryForContext,
  searchMemory,
  memoryStats,
  memorySubjects,
  insertPinned,
  findMemoryItemByText,
  editMemoryItemContent,
  removeMemoryItem,
} from '../../db/repos/memoryItem.repo.js';
import { listEpisodes, recentEpisodes, episodeCount } from '../../db/repos/episode.repo.js';
import { listProfiles } from '../../db/repos/profile.repo.js';
import { renderEpisodeLine } from '../../episodes/render.js';
import { searchEpisodes } from '../../episodes/search.js';
import { buildTopicIndex } from '../../util/topicIndex.js';
import { addExpenseTerms } from '../../db/repos/expenseTerm.repo.js';
import { getVoiceLexicon, setGloss } from '../../db/repos/lexicon.repo.js';
import {
  addRule,
  listRules,
  removeRule,
  findRule,
} from '../../db/repos/chatRule.repo.js';
import { addPoi, listPois } from '../../db/repos/poi.repo.js';
import { normalizeCategory } from '../../util/poi.js';
import {
  getTimezone,
  setTimezone,
  getChatMode,
  getPersonaPrompt,
  isChatHumorEnabled,
  isChatSlangEnabled,
} from '../../db/repos/chatSettings.repo.js';
import {
  createTask,
  listTasks,
  findDuplicate,
  deleteTask,
  rescheduleTask,
} from '../../db/repos/scheduledTask.repo.js';
import {
  createWatch,
  listWatches,
  findDuplicateWatch,
} from '../../db/repos/pageWatch.repo.js';
import {
  createFlightWatch,
  listFlightWatches,
  findDuplicateFlightWatch,
} from '../../db/repos/flightWatch.repo.js';
import { makeFlightStatusHandler } from '../../flight/handler.js';
import { normalizeFlightNumber } from '../../flight/status.js';
import {
  nextRunMs,
  isValidSchedule,
  isValidTimezone,
  formatInTimezone,
  cronForInstant,
  formatDelay,
} from '../../util/schedule.js';
import type {
  ScheduleTaskInput,
  ManageTaskInput,
  WatchPageInput,
  WatchFlightInput,
  AddPoiInput,
  EditLexiconInput,
  EditPingListInput,
  EditMemoryInput,
  SetRuleInput,
  SetTimezoneInput,
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
import { FORWARDED_MESSAGE_MARKER, VOICE_TRANSCRIPT_MARKER } from '../../llm/prompts.js';
import { forwardOrigin } from '../forwarded.js';
import {
  takeForwards,
  renderForwardBatch,
  clearMarks,
  type BufferedForward,
  type ForwardImageState,
} from '../forwardBuffer.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';
import { modeAllowsHumor, modeAllowsSlang } from '../../modes.js';

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
    // The journal is the episodic half of the same deep tier: one recall reaches
    // both remembered FACTS and notes of past CONVERSATIONS, so «а о чём мы тогда
    // говорили про X» resolves in one search. Searched by the free-text query
    // (and by `about` when that's all there is — a person's name matches the
    // notes that mention them).
    const epQuery = q || who;
    const episodeHits =
      epQuery && cfg.ENABLE_EPISODES && cfg.ENABLE_CHAT_LOG
        ? searchEpisodes(listEpisodes(chatId), epQuery, { limit: cfg.EPISODE_RECALL_LIMIT })
        : [];
    const scope = who ? `про «${who}»${q ? ` по запросу «${q}»` : ''}` : `по запросу «${q}»`;
    if (hits.length === 0 && episodeHits.length === 0) {
      const { total } = memoryStats(chatId);
      return total === 0
        ? 'В памяти этого чата пока пусто — честно скажи, что не знаешь.'
        : `Ничего не нашёл ${scope} (в памяти ${total} записей). Попробуй другие слова — или честно скажи, что не помнишь, не выдумывай.`;
    }

    const out: string[] = [];
    if (hits.length > 0) {
      out.push(`Нашёл в памяти ${scope} (${hits.length} записей, самое подходящее сверху):`);
      for (const h of hits) {
        const tag = h.item.scope === 'persona' ? '🎭 ' : h.item.source === 'explicit' ? '📌 ' : '';
        const subject = h.item.scope === 'user' && h.item.subject ? `[${h.item.subject}] ` : '';
        out.push(`- ${tag}${subject}${h.item.content}`);
      }
    } else {
      out.push(`По фактам ничего не нашёл ${scope}, но в журнале бесед есть подходящее:`);
    }
    if (episodeHits.length > 0) {
      const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
      if (hits.length > 0) {
        out.push('Ещё из журнала бесед (конспекты прошлых разговоров, НЕ дословно):');
      }
      for (const h of episodeHits) out.push(`- ${renderEpisodeLine(h.episode, tz)}`);
      out.push(
        'Нужна точная переписка или подробный пересказ той беседы — вызови summarize_chat с датами из строки журнала.',
      );
    }
    out.push('Это память чата — используй её, но не выдумывай того, чего тут нет.');
    logger.debug(
      { chatId, query: q, about: who, hits: hits.length, episodeHits: episodeHits.length },
      'recall_memory served',
    );
    return out.join('\n');
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
 * Resolve a reminder's timing from the model's input: a RELATIVE delay
 * (`inMinutes` — computed here from the server clock, so the model never turns
 * «через час 50» into a clock time in the wrong zone) or an ABSOLUTE cron in the
 * chat's timezone. Returns the fire instant + the cron to store (derived for the
 * relative case, so /tasks and dedup keep working), or a human error line.
 */
function resolveTiming(
  input: { cron?: string | null; inMinutes?: number | null },
  tz: string,
): { cron: string; nextRunAt: number; delayMinutes: number | null } | { error: string } {
  if (input.inMinutes != null && input.inMinutes > 0) {
    const minutes = Math.round(input.inMinutes);
    const nextRunAt = Date.now() + minutes * 60_000;
    const cron = cronForInstant(nextRunAt, tz);
    if (!cron) return { error: 'Не понял часовой пояс — уточни, где ты.' };
    return { cron, nextRunAt, delayMinutes: minutes };
  }
  const cron = input.cron?.trim();
  if (!cron) {
    return { error: 'Не понял время — скажи, через сколько или во сколько напомнить.' };
  }
  if (!isValidSchedule(cron, tz)) {
    return { error: 'Не понял расписание — уточни время (напр. «каждый день в 9 утра»).' };
  }
  const next = nextRunMs(cron, tz);
  if (next === null) return { error: 'Это расписание уже не сработает — уточни время.' };
  return { cron, nextRunAt: next, delayMinutes: null };
}

/**
 * Build the `schedule_task` handler for a chat: validates the model's cron +
 * timezone (or computes a relative delay itself), persists the task, remembers
 * the chat timezone (so we only ask once), and returns a human confirmation the
 * assistant relays back.
 */
export function makeScheduleTaskHandler(
  chatId: number,
  tgUserId: number,
  defaultTz: string,
): (input: ScheduleTaskInput) => string {
  return (input) => {
    const tz = isValidTimezone(input.timezone) ? input.timezone : defaultTz;
    const timing = resolveTiming(input, tz);
    if ('error' in timing) return timing.error;
    setTimezone(chatId, tz);
    // Guard against re-creating a reminder that already exists (e.g. the original
    // request lingering in conversation history makes the model fire again).
    const dup = findDuplicate(listTasks(chatId), { cron: timing.cron, title: input.title });
    if (dup) {
      return `Это уже стоит — #${dup.id} «${dup.title}» (следующий запуск ${formatInTimezone(dup.nextRunAt, dup.timezone)}).`;
    }
    // A relative reminder is one-off by nature: «через час 50» names a moment,
    // and its derived cron would otherwise re-fire on that date every year.
    const once = timing.delayMinutes !== null ? true : input.once;
    const id = createTask({
      chatId,
      tgUserId,
      title: input.title,
      prompt: input.prompt,
      cron: timing.cron,
      timezone: tz,
      once,
      humor: input.humor,
      nextRunAt: timing.nextRunAt,
    });
    const when = formatInTimezone(timing.nextRunAt, tz);
    const kind = once ? 'Напоминание' : 'Регулярная задача';
    const humorNote = input.humor ? ' 😂 с юмором' : '';
    const delay = timing.delayMinutes !== null ? `${formatDelay(timing.delayMinutes)} — ` : '';
    return `${kind} #${id} «${input.title}»${humorNote} создана. Первый запуск: ${delay}${when} (${tz}). Список: /tasks`;
  };
}

/**
 * Build the `manage_task` handler for a chat — the «перенеси напоминание на
 * 19:30» / «отмени напоминание про сушилку» flow. Moves or deletes an EXISTING
 * task by id (chat-scoped), so a change never leaves a duplicate behind.
 */
export function makeManageTaskHandler(
  chatId: number,
  defaultTz: string,
): (input: ManageTaskInput) => string {
  return (input) => {
    const task = listTasks(chatId).find((t) => t.id === input.id);
    if (!task) {
      return `Не нашёл активное напоминание #${input.id} в этом чате. Список: /tasks`;
    }
    if (input.action === 'cancel') {
      deleteTask(task.id, chatId);
      return `🗑 Напоминание #${task.id} «${task.title}» удалено.`;
    }
    const wanted = input.timezone?.trim();
    const tz = wanted && isValidTimezone(wanted) ? wanted : task.timezone || defaultTz;
    const timing = resolveTiming(input, tz);
    if ('error' in timing) return timing.error;
    if (
      !rescheduleTask(task.id, chatId, {
        cron: timing.cron,
        timezone: tz,
        nextRunAt: timing.nextRunAt,
      })
    ) {
      return `Не нашёл активное напоминание #${input.id} в этом чате. Список: /tasks`;
    }
    const when = formatInTimezone(timing.nextRunAt, tz);
    const delay = timing.delayMinutes !== null ? `${formatDelay(timing.delayMinutes)} — ` : '';
    return `Перенёс #${task.id} «${task.title}»: следующий запуск ${delay}${when} (${tz}). Старое время снято, дубля нет.`;
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
 * Build the `watch_flight` handler for a chat — the «следи за рейсом и напиши,
 * если отменят/перенесут» flow. Validates the flight number, guards against
 * duplicates and a per-chat cap (each poll is a metered feed request), computes
 * the watch's lifetime from the flight date, arms it (first poll on the next
 * runner tick) and returns a human confirmation.
 */
export function makeWatchFlightHandler(
  chatId: number,
  tgUserId: number,
): (input: WatchFlightInput) => string {
  return (input) => {
    const cfg = loadConfig();
    const flight = normalizeFlightNumber(input.flight);
    if (!flight) {
      return `Не похоже на номер рейса: «${input.flight}». Нужен код авиакомпании + номер, например K6829.`;
    }
    const now = Date.now();
    // Lifetime: a dated watch lives until two days past its date (covers a
    // reschedule to the next day); an undated one gets the configured default.
    let expiresAt: number;
    if (input.date) {
      const dateMs = Date.parse(`${input.date}T00:00:00Z`);
      if (Number.isNaN(dateMs)) return 'Не понял дату рейса — назови её как YYYY-MM-DD.';
      expiresAt = dateMs + 2 * 24 * 3600_000;
      if (expiresAt <= now) {
        return `Рейс ${flight} на ${input.date} уже в прошлом — следить не за чем. Могу проверить, чем он закончился: спроси статус.`;
      }
    } else {
      expiresAt = now + cfg.FLIGHT_WATCH_EXPIRES_HOURS * 3600_000;
    }
    const active = listFlightWatches(chatId);
    const dup = findDuplicateFlightWatch(active, { flight, flightDate: input.date });
    if (dup) {
      return `Уже слежу за этим рейсом — #${dup.id} «${dup.title}». Список: /flight`;
    }
    if (active.length >= cfg.FLIGHT_WATCH_MAX_PER_CHAT) {
      return `В этом чате уже ${active.length} рейсов под наблюдением — это потолок. Сними лишний: /flight del <id> (список: /flight)`;
    }
    // Stored pace is only the FALLBACK for when no departure time is known yet —
    // live pacing is adaptive (see adaptivePollMinutes). Clamped to ≥15 min:
    // every poll is one metered feed request.
    const interval = Math.min(Math.max(cfg.FLIGHT_WATCH_INTERVAL_MINUTES, 15), 24 * 60);
    const id = createFlightWatch({
      chatId,
      tgUserId,
      title: input.title,
      flight,
      flightDate: input.date,
      intervalMinutes: interval,
      expiresAt,
      // Due immediately: the runner's next minute tick does the first poll.
      nextCheckAt: now,
    });
    return (
      `🛩 Слежка #${id} «${input.title}»: слежу за рейсом ${flight}` +
      `${input.date ? ` на ${input.date}` : ''} и напишу сюда, если его отменят или ` +
      `перенесут, назначат/поменяют гейт, он вылетит или сядет. Проверяю адаптивно: ` +
      `изредка задолго до вылета, чаще в последние часы; в полёте не дёргаю данные ` +
      `зря — проснусь к расчётной посадке (с запасом на ранний прилёт). Список: /flight`
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
 * Build the `set_rule` handler for a chat — the «с этого момента все голосовые
 * очищай от слов-паразитов и скидывай расшифровку» flow. A rule is a standing
 * ORDER (as opposed to memory, which is a fact), so it lands in its own small,
 * capped list that is injected into every turn as directives.
 *
 * Removal matches forgivingly (the model quotes the rule back in its own words);
 * an ambiguous or unknown quote is reported rather than guessed at, so a wrong
 * rule is never dropped silently.
 */
export function makeSetRuleHandler(
  chatId: number,
  tgUserId: number,
): (input: SetRuleInput) => string {
  return ({ action, text }) => {
    const max = loadConfig().CHAT_RULES_MAX;
    if (action === 'remove') {
      const found = findRule(chatId, text);
      if (!found) {
        return `Не нашёл такого правила. Текущие правила: /rules`;
      }
      removeRule(chatId, found.id);
      return `Убрал правило: «${found.text}». Что осталось — /rules`;
    }
    const res = addRule({ chatId, text, tgUserId, max });
    if (res.status === 'duplicate') {
      return `Такое правило уже действует: «${res.rule.text}». Ничего не менял.`;
    }
    if (res.status === 'full') {
      return `Правил уже ${res.max} — это максимум. Удали лишнее (/rules del <N>) и повтори.`;
    }
    return `Записал правило: «${res.rule.text}». Действует со следующего ответа. Все правила — /rules`;
  };
}

/**
 * Build the `set_timezone` handler for a chat — the «я во Вьетнаме» flow. The
 * chat timezone drives reminders, calendar digests and time display, so a plain
 * statement of where the user is must be enough to move the clock. Validated
 * against Intl; the confirmation carries the resulting local time so a wrong
 * mapping is immediately visible.
 */
export function makeSetTimezoneHandler(chatId: number): (input: SetTimezoneInput) => string {
  return ({ timezone, place }) => {
    const tz = timezone.trim();
    if (!isValidTimezone(tz)) {
      return `Не понял зону «${tz}» — назови город покрупнее или страну, я подберу таймзону.`;
    }
    setTimezone(chatId, tz);
    const localNow = formatInTimezone(Date.now(), tz);
    const label = place?.trim() ? ` (${place.trim()})` : '';
    return (
      `Часовой пояс чата теперь ${tz}${label}, локальное время: ${localNow}. Напоминания, календарь и расписания идут по нему.` +
      // The context block of THIS turn was rendered before the switch — any
      // times the model already saw there may be in the old zone. Without this
      // note it compares them with fresh tool data and reports phantom
      // discrepancies («в календаре 11:25, а рейс в 18:25»).
      ' (Важно: контекст этого сообщения был собран ДО смены пояса — показанные выше времена календаря могли быть в старой зоне. Не сравнивай их с другими источниками; нужны времена — вызови calendar_events заново с новой зоной.)'
    );
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
  /**
   * Consume the chat's pending forward batch into this turn (see
   * forwardBuffer.ts). Opt-in and set ONLY by the real user-facing entry points
   * (onMessage / onVoice / onPhoto / the mark-tap handler) — a chime or a reword
   * must never swallow a pack the user forwarded for a question they haven't
   * asked yet.
   */
  includeForwardBatch?: boolean;
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

/**
 * Put the channel markers in front of the user's content. A photo/receipt turn is
 * a block array, so the prefix becomes its own leading text block rather than
 * being glued onto a caption that may not exist.
 */
function applyPrefix(
  content: string | Anthropic.ContentBlockParam[],
  prefix: string,
): string | Anthropic.ContentBlockParam[] {
  if (!prefix) return content;
  if (typeof content === 'string') return `${prefix}${content}`;
  return [{ type: 'text', text: prefix.trimEnd() }, ...content];
}

/**
 * Download the pictures a drained forward batch parked (photos and images sent
 * as files) and build their image blocks, in entry order. The first `maxPhotos`
 * are attached; the rest are marked skipped, and a failed download degrades that
 * one entry to caption-only — both states reach the model via the rendered
 * block, and neither aborts the turn.
 */
async function collectForwardImages(
  ctx: Context,
  entries: BufferedForward[],
  maxPhotos: number,
): Promise<{ blocks: Anthropic.ContentBlockParam[]; states: Map<number, ForwardImageState> }> {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const states = new Map<number, ForwardImageState>();
  let attached = 0;
  for (const [i, entry] of entries.entries()) {
    if (!entry.image) continue;
    if (attached >= maxPhotos) {
      states.set(i, 'skipped');
      continue;
    }
    try {
      const bytes = await downloadTelegramFile(ctx, entry.image.fileId);
      attached++;
      states.set(i, { attached });
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: entry.image.mediaType,
          data: bytes.toString('base64'),
        },
      });
    } catch (err) {
      logger.warn({ err, chatId: ctx.chat?.id }, 'failed to download a forwarded picture');
      states.set(i, 'failed');
    }
  }
  return { blocks, states };
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
  // An UNADDRESSED message that merely looks like a spend is an expense-only scan:
  // the assistant may record an expense or produce nothing, and any text it writes is
  // dropped below. Memory has no job there — and it actively hurts, because a
  // remembered «я — Швед» tempts the model to take the payer from memory instead of
  // from the sender. So skip the memory work entirely (also saves the queries and
  // the tokens) and tell runAssistant to run in expense-only shape.
  const expenseOnly = !args.addressed;
  // An ADDRESSED turn that is SHAPED like a spend (a typed «такси 500 на всех», a
  // voice note «264, раздели-ка на нас», a receipt photo captioned «за меня и
  // Колю») runs MEMORY-FREE too: no facts, no profile cards, no journal, and the
  // recall/summarize tools off — but the full toolset otherwise, so a false
  // positive («напомни заплатить 500 за аренду») still lands as a reminder. The
  // journal is the worst offender: it summarises the bot's own «✅ Записал …»
  // posts, so a past expense reads as an existing record and even lends its
  // title to the new one («судя по журналу это новая покупка метро»).
  const memoryFree =
    expenseOnly ||
    isExpenseShaped({ chatId, text: args.historyText, source: args.source });
  if (memoryFree && !expenseOnly) {
    logger.info({ chatId, source: args.source }, 'expense-shaped turn: memory-free');
  }
  const memorySel = memoryFree
    ? { chat: [], users: [], persona: [] }
    : getMemoryForContext(chatId, {
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
  // The «custom» preset's persona description (null elsewhere): it feeds both the
  // system prompt and the tone pass, so the chat speaks one character throughout.
  const personaPrompt = mode === 'custom' ? getPersonaPrompt(chatId) : null;

  // Episodic context: the conversation journal (what the last few sessions were
  // about) plus the topic index for the memory depth hint. Off on the
  // expense-only scan (conversation-only context, same rule as memory) and in
  // tutor chats (the journal's verbatim-expansion path — summarize_chat — is not
  // exposed there, so a journal that advises calling it would dangle).
  const journalOn =
    !memoryFree && mode !== 'tutor' && cfg.ENABLE_EPISODES && cfg.ENABLE_CHAT_LOG;
  const journalTz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
  const journal = journalOn ? recentEpisodes(chatId, cfg.EPISODE_CONTEXT_COUNT) : [];
  const episodeTotal = journalOn ? episodeCount(chatId) : 0;
  const memoryTopics = memoryFree
    ? []
    : buildTopicIndex({
        subjects: memorySubjects(chatId),
        episodeTopics: journalOn ? listEpisodes(chatId).map((e) => e.topics) : [],
        max: cfg.MEMORY_TOPIC_INDEX_MAX,
      });

  // Channel markers. A voice note reaches the model as a machine transcript and a
  // forwarded message carries someone else's words — the model cannot tell either
  // from a plain typed message on its own, and a chat RULE can only key on what it
  // can see («все голосовые очищай от слов-паразитов», «ничего не запоминай из
  // пересланных»). Both markers are explained verbatim in the system prompt, which
  // also says to answer the content normally unless a rule asks for more, so an
  // unmarked message behaves exactly as before.
  const origin = forwardOrigin(ctx.message);
  const markers: string[] = [];
  if (origin) markers.push(`${FORWARDED_MESSAGE_MARKER} (источник: ${origin})`);
  if (args.source === 'voice') markers.push(VOICE_TRANSCRIPT_MARKER);
  const prefix = markers.length > 0 ? `${markers.join('\n')}\n` : '';

  // A pending forward batch (messages forwarded just before this ask) becomes the
  // turn's leading context, and its reaction marks come off — the pack is consumed.
  // Drained only на addressed turns from real entry points (see the flag docs).
  const batch =
    args.includeForwardBatch && args.addressed ? takeForwards(chatId) : { entries: [], overflow: 0 };
  if (batch.entries.length > 0) {
    void clearMarks(ctx.api, chatId, batch.entries);
  }
  // Buffered forwards parked only file_ids for their pictures; the drain is where
  // the downloads happen (an expired pack costs none). Each attached picture is
  // announced in the rendered block by its number; a failed download or the
  // over-cap tail is announced too, so the model never guesses what it can see.
  const batchImages =
    batch.entries.length > 0
      ? await collectForwardImages(ctx, batch.entries, cfg.FORWARD_BUFFER_MAX_PHOTOS)
      : { blocks: [], states: new Map<number, ForwardImageState>() };
  const batchBlock =
    batch.entries.length > 0
      ? `${renderForwardBatch(batch.entries, batch.overflow, batchImages.states)}\n`
      : '';

  let userContent = applyPrefix(args.userContent, prefix);
  if (batchBlock) {
    if (batchImages.blocks.length > 0) {
      // Pictures force the block-array shape: batch text, then the images in
      // their announced order, then the user's own (marker-prefixed) content.
      const rest: Anthropic.ContentBlockParam[] =
        typeof userContent === 'string'
          ? userContent
            ? [{ type: 'text', text: userContent }]
            : []
          : userContent;
      userContent = [{ type: 'text', text: batchBlock.trimEnd() }, ...batchImages.blocks, ...rest];
    } else {
      userContent = applyPrefix(userContent, batchBlock);
    }
  }
  // History keeps the tags too: without them, a forwarded message read back from
  // history next turn looks like something the sender said themselves, and a
  // batch-consuming exchange loses what it was about. The batch itself is NOT
  // stored (it would blow the small history window) — the reply carries the gist.
  const batchTag = batch.entries.length > 0 ? `[+пачка из ${batch.entries.length} пересланных] ` : '';
  const historyText = `${batchTag}${origin ? `[переслано] ` : ''}${args.historyText}`;

  let result: AssistantResult;
  try {
    result = await runAssistant(
      {
        mode,
        personaPrompt,
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
        memoryTotal: memoryFree ? 0 : memoryStats(chatId).total,
        // The conversation journal (episodic memory) + what the deep tier covers.
        episodes: journal.map((e) => renderEpisodeLine(e, journalTz)),
        episodeTotal,
        memoryTopics,
        // Profile cards: the maintained portrait (chat card first, freshest people
        // next — listProfiles orders that way). Memory-gated like the fact sections.
        profiles:
          memoryFree || mode === 'tutor' || !cfg.ENABLE_PROFILES || !cfg.ENABLE_MEMORY
            ? []
            : listProfiles(chatId)
                .slice(0, cfg.PROFILE_CONTEXT_MAX)
                .map((p) => ({ subject: p.subject, content: p.content })),
        expenseOnly,
        memoryFree,
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
        activeFlightWatches: listFlightWatches(chatId).map((w) => ({
          id: w.id,
          flight: w.flight,
          date: w.flightDate,
          title: w.title,
        })),
        places: listPois(chatId).map((p) => ({ name: p.name, category: p.category })),
        // The chat's OWN calendar only (repo reads are chat-scoped): gates the
        // calendar_events tool and gives the model a peek at what's coming.
        // Skipped on the expense-only scan — conversation-only context.
        calendarConnected: !expenseOnly && calendarConnected(chatId),
        calendarLines:
          !expenseOnly && calendarConnected(chatId)
            ? upcomingCalendarLines(chatId, journalTz, cfg.CALENDAR_CONTEXT_EVENTS)
            : [],
        // Standing behaviour rules for this chat — orders, not context (see
        // chat_rule / the set_rule tool). They apply in every mode.
        rules: listRules(chatId).map((r) => r.text),
        // Who runs the bot here, so «кто ты и чей ты?» names real admins.
        botAdmins: botAdminLabels(chatId),
        history,
        userContent,
      },
      {
        remember: (input) => rememberNote(chatId, input.note, input.replaces),
        editMemory: makeEditMemoryHandler(chatId),
        recallMemory: makeRecallMemoryHandler(chatId),
        learnExpense: makeLearnExpenseHandler(chatId, tgUserId),
        editLexicon: makeEditLexiconHandler(chatId),
        editPingList: makeEditPingListHandler(chatId, tgUserId),
        setRule: makeSetRuleHandler(chatId, tgUserId),
        setTimezone: makeSetTimezoneHandler(chatId),
        scheduleTask: makeScheduleTaskHandler(chatId, tgUserId, cfg.DEFAULT_TIMEZONE),
        manageTask: makeManageTaskHandler(chatId, cfg.DEFAULT_TIMEZONE),
        watchPage: makeWatchPageHandler(chatId, tgUserId),
        flightStatus: makeFlightStatusHandler(chatId),
        watchFlight: makeWatchFlightHandler(chatId, tgUserId),
        dotaLookup: makeDotaLookupHandler(),
        surfForecast: makeSurfForecastHandler(),
        addPoi: makeAddPoiHandler(chatId, tgUserId),
        spendingReport: makeSpendingReportHandler(chatId),
        summarizeChat: makeSummarizeChatHandler(chatId),
        calendarEvents: makeCalendarEventsHandler(chatId),
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
    userText: historyText,
    chatId,
  });
  const decision = classifyHumorDecision({
    // The humorizer runs only when it's on globally, allowed by the chat's MODE
    // (a calm assistant / a tutor never jokes) AND not switched off for THIS chat
    // (/humor <chatId> off) — a silenced chat gets Claude's text as-is.
    enabled: isHumorEnabled() && modeAllowsHumor(mode) && isChatHumorEnabled(chatId),
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
        // schoolkid-sensei rewrite, a custom chat its own described character.
        humorPersonaForMode(mode, personaPrompt),
      )
    : result.text;

  // Everything the humorizer is banned from — tool/factual answers, money
  // answers, chats with the jokes switched off — still gets the chat's WORDS,
  // just not its jokes: the slang pass swaps vocabulary only and drops the
  // rewrite if any number/link/@handle moved. So an exact answer speaks the
  // group's lingo without its facts being at risk. Tutor chats stay clean.
  const slangDecision = classifySlangDecision({
    enabled: isSlangPassEnabled() && modeAllowsSlang(mode) && isChatSlangEnabled(chatId),
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
  // The bot's own post belongs in the raw log too — a recap that shows only what
  // people said reads as a monologue and loses what was answered/decided.
  recordChatLog({ chatId, role: 'assistant', tgUserId: null, content: replyText });
  // A reminder request is a completed side-action, not dialogue — keep it out of
  // history so it can't replay and re-create the reminder on a later message.
  if (result.scheduled) return 'replied';
  // Record this conversational exchange (and only this) for future context.
  // Store what we actually sent (the humorized text) so history matches the chat.
  addTurn({ chatId, role: 'user', tgUserId, senderName: senderName(ctx), content: historyText });
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
      setRule: makeSetRuleHandler(chatId, tgUserId),
      setTimezone: makeSetTimezoneHandler(chatId),
      scheduleTask: makeScheduleTaskHandler(chatId, tgUserId, cfg.DEFAULT_TIMEZONE),
      manageTask: makeManageTaskHandler(chatId, cfg.DEFAULT_TIMEZONE),
      watchPage: makeWatchPageHandler(chatId, tgUserId),
      flightStatus: makeFlightStatusHandler(chatId),
      watchFlight: makeWatchFlightHandler(chatId, tgUserId),
      dotaLookup: makeDotaLookupHandler(),
      surfForecast: makeSurfForecastHandler(),
      addPoi: makeAddPoiHandler(chatId, tgUserId),
      spendingReport: makeSpendingReportHandler(chatId),
      summarizeChat: makeSummarizeChatHandler(chatId),
      calendarEvents: makeCalendarEventsHandler(chatId),
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
