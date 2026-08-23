import type { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { runAssistant } from './llm/assistant.js';
import {
  dueTasks,
  setNextRun,
  disableTask,
  type ScheduledTask,
} from './db/repos/scheduledTask.repo.js';
import { nextRunMs } from './util/schedule.js';
import { sendRichMarkdown } from './util/richMessage.js';
import { humorizeWithPreview } from './llm/humorize.js';
import {
  applySlangOrOriginal,
  classifySlangDecision,
  isSlangPassEnabled,
} from './llm/slang.js';
import { getVoiceLexicon } from './db/repos/lexicon.repo.js';
import { listRules } from './db/repos/chatRule.repo.js';
import { modeAllowsHumor, modeAllowsSlang } from './modes.js';
import { getRecentChat } from './bot/recentChat.js';
import { makeSurfForecastHandler } from './surf/index.js';
import { makeDotaLookupHandler } from './dota/lookup.js';
import { makeSpendingReportHandler } from './spending/handler.js';
import { makeSummarizeChatHandler } from './summary/handler.js';
import { recordChatLog } from './bot/chatLog.js';
import { getProvider } from './core/registry.js';
import { getChatConfig } from './db/repos/chatConfig.repo.js';
import {
  getChatMode,
  isChatHumorEnabled,
  isChatSlangEnabled,
} from './db/repos/chatSettings.repo.js';
import {
  getMemoryForContext,
  memoryStats,
  memorySubjects,
} from './db/repos/memoryItem.repo.js';
import { listEpisodes, recentEpisodes, episodeCount } from './db/repos/episode.repo.js';
import { listProfiles } from './db/repos/profile.repo.js';
import { renderEpisodeLine } from './episodes/render.js';
import { buildTopicIndex } from './util/topicIndex.js';
import { makeRecallMemoryHandler } from './bot/flows/assist.js';
import { addTurn, pruneOld } from './db/repos/conversation.repo.js';
import type { Member } from './core/types.js';
import type { Config } from './config.js';

const surfForecast = makeSurfForecastHandler();
const dotaLookup = makeDotaLookupHandler();

/**
 * Build the memory working set for a scheduled run. A scheduled task fires with
 * no chat history, but it should still see the chat's durable memory — shared
 * group facts plus the task creator's per-person facts — so a recurring task
 * (e.g. a daily "рофельный прогноз по Бали") can riff on what the bot actually
 * knows about the group instead of running blind. Returns the context-ready shape
 * `runAssistant` expects. Exported for testing.
 */
export function scheduledMemory(
  chatId: number,
  creatorTgUserId: number | null,
  cfg: Config,
): {
  memoryChat: { content: string }[];
  memoryUsers: { subject: string; items: { content: string }[] }[];
  memoryPersona: { content: string }[];
  memoryTotal: number;
} {
  const sel = getMemoryForContext(chatId, {
    // No recent conversation in a scheduled run, so there are no other
    // participants to surface; the creator stands in as the "sender" so their
    // per-person facts come along with the shared chat memory.
    senderTgUserId: creatorTgUserId ?? 0,
    recentParticipantIds: [],
    halfLifeDays: cfg.MEMORY_HALFLIFE_DAYS,
    chatBudget: cfg.MEMORY_CONTEXT_CHAT,
    userBudget: cfg.MEMORY_CONTEXT_USER,
    pinnedChatBudget: cfg.MEMORY_CONTEXT_PINNED,
    personaBudget: cfg.MEMORY_CONTEXT_PERSONA,
  });
  return {
    memoryChat: sel.chat.map((i) => ({ content: i.content })),
    memoryUsers: sel.users.map((u) => ({
      subject: u.subject,
      items: u.items.map((i) => ({ content: i.content })),
    })),
    memoryPersona: sel.persona.map((i) => ({ content: i.content })),
    memoryTotal: memoryStats(chatId).total,
  };
}

async function sendMarkdown(bot: Bot, chatId: number, text: string): Promise<void> {
  await sendRichMarkdown(bot.api, chatId, text);
}

async function runTask(bot: Bot, task: ScheduledTask): Promise<void> {
  const cfg = loadConfig();
  try {
    // Load the chat's Splid context so a recurring "сводка трат в 9 утра" task can
    // use the spending_report tool (gated on a connected group). Best-effort: a
    // plain reminder/surf task works fine without it.
    const chatCfg = getChatConfig(task.chatId);
    let members: Member[] = [];
    if (chatCfg?.provider_group_id) {
      try {
        members = await getProvider(chatCfg.provider_name).listMembers({
          groupId: chatCfg.provider_group_id,
        });
      } catch (err) {
        logger.warn({ err, chatId: task.chatId }, 'could not load members for scheduled task');
      }
    }

    // Scheduled runs fire with no chat history, but they SHOULD still see the
    // chat's durable memory so a recurring task can use what the bot knows about
    // the group (e.g. a daily joke forecast riffing on remembered facts).
    const { memoryChat, memoryUsers, memoryPersona, memoryTotal } = scheduledMemory(
      task.chatId,
      task.tgUserId,
      cfg,
    );

    // A humour task is a "vibe" post, not a plain reminder: give it the chat's
    // recent chatter so it can riff on what was just said (the same in-memory
    // buffer the chime uses). Factual tasks (surf/spending reminders) stay
    // context-clean so recent banter can't distract them from their job.
    let userContent = task.prompt;
    if (task.humor) {
      const recent = getRecentChat(task.chatId);
      if (recent.length > 0) {
        const lines = recent.map((r) => `${r.name}: ${r.text}`).join('\n');
        userContent =
          `${task.prompt}\n\n[Свежий контекст чата (последние сообщения) — можешь ` +
          `опираться на него и обыграть, но это не обязательно:\n${lines}]`;
      }
    }

    // A task fired in a tutor chat keeps the tutor persona (and its no-humor,
    // reduced-tools behaviour) — e.g. a daily "порешай со мной задачи" ping.
    // Likewise a dota chat's tasks keep the dota-sensei persona.
    const mode = getChatMode(task.chatId);

    // The conversation journal reaches scheduled runs too — a firing task has no
    // chat history at all, so «what was recently talked about» is even more
    // valuable there. Same gating as the live path (tutor excluded: it has no
    // summarize_chat to expand an entry with).
    const journalOn =
      mode !== 'tutor' && cfg.ENABLE_EPISODES && cfg.ENABLE_CHAT_LOG;
    const journalTz = task.timezone || cfg.DEFAULT_TIMEZONE;
    const journal = journalOn
      ? recentEpisodes(task.chatId, cfg.EPISODE_CONTEXT_COUNT)
      : [];
    const memoryTopics = buildTopicIndex({
      subjects: memorySubjects(task.chatId),
      episodeTopics: journalOn ? listEpisodes(task.chatId).map((e) => e.topics) : [],
      max: cfg.MEMORY_TOPIC_INDEX_MAX,
    });

    const result = await runAssistant(
      {
        mode,
        episodes: journal.map((e) => renderEpisodeLine(e, journalTz)),
        episodeTotal: journalOn ? episodeCount(task.chatId) : 0,
        memoryTopics,
        profiles:
          mode === 'tutor' || !cfg.ENABLE_PROFILES || !cfg.ENABLE_MEMORY
            ? []
            : listProfiles(task.chatId)
                .slice(0, cfg.PROFILE_CONTEXT_MAX)
                .map((p) => ({ subject: p.subject, content: p.content })),
        defaultCurrency: chatCfg?.default_currency ?? cfg.DEFAULT_CURRENCY,
        members: members.map((m) => ({ name: m.name, initials: m.initials })),
        memoryChat,
        memoryUsers,
        memoryPersona,
        memoryTotal,
        senderName: 'scheduler',
        timezone: task.timezone,
        // The chat's standing rules apply to a scheduled post exactly as they do to
        // a live reply — «без эмодзи» must not lapse just because a timer fired it.
        rules: listRules(task.chatId).map((r) => r.text),
        splidConnected: !!chatCfg?.provider_group_id,
        // A firing reminder just produces text (optionally via web search). It must
        // NOT be able to create reminders or write memory — otherwise a reminder
        // could spawn more reminders every time it runs.
        allowRemember: false, // also gates edit_memory (both off for firing tasks)
        allowExpenseLearning: false,
        allowLexiconEdit: false,
        allowPingEdit: false,
        // A firing task must not rewrite how the bot behaves in the chat either.
        allowRules: false,
        allowReminders: false,
        // A firing task must not arm page watches either — same self-spawning risk.
        allowWatch: false,
        allowPoi: false,
        history: [],
        userContent,
      },
      {
        remember: () => 'noop',
        editMemory: () => 'noop',
        // Recall stays LIVE: a firing task ("напомни про днюхи на неделе") needs to
        // reach the store just like a live turn does, and it only reads.
        recallMemory: makeRecallMemoryHandler(task.chatId),
        learnExpense: () => 'noop',
        editLexicon: () => 'noop',
        editPingList: () => 'noop',
        setRule: () => 'noop',
        scheduleTask: () => 'noop',
        watchPage: () => 'noop',
        // Dota lookup stays live: a recurring "разбор патча по утрам" task needs
        // the current-patch numbers exactly like an on-demand question does.
        dotaLookup,
        // Surf forecast stays live: a recurring evening task asks for tomorrow's
        // forecast and the bot posts the recommendation to the chat.
        surfForecast,
        addPoi: () => 'noop',
        // Spending report stays live too: a recurring task can post the daily
        // spending digest (it short-circuits to ready, humorized text).
        spendingReport: makeSpendingReportHandler(task.chatId),
        // Recapping the chat log stays live as well: «каждое утро перескажи, что
        // было вчера» is exactly a scheduled summary, and the tool only reads.
        summarizeChat: makeSummarizeChatHandler(task.chatId),
      },
    );
    if (result.kind === 'text' && result.text.trim()) {
      // A task can opt into the tone-only humorizer (set when it was created).
      // Mirror the live chat flow: only a plain-chat answer (no tool used) is
      // eligible — a tool result (e.g. a surf forecast) carries facts that must
      // stay verbatim. The spending report self-humorizes inside its handler.
      // Best-effort: when humour is globally disabled or OpenAI fails, the
      // original text is returned unchanged. Like the live flow, the pre-OpenAI
      // original is DM'd to the admin so the before/after can be compared.
      // The lexicon honours the chat's /slang switch (empty list when off), and
      // feeds whichever pass runs below.
      const lexicon = getVoiceLexicon(task.chatId, cfg.LEXICON_MAX_TERMS);
      // Per-chat humor off trumps the task's own humor flag — the admin
      // silenced the jokes for that chat entirely.
      const humorRan = !!(
        task.humor &&
        result.humorizable &&
        modeAllowsHumor(mode) &&
        isChatHumorEnabled(task.chatId)
      );
      const humorized = humorRan
        ? await humorizeWithPreview(
            result.text,
            async (original) => {
              await bot.api.sendMessage(
                cfg.ADMIN_TELEGRAM_ID,
                `🔬 До OpenAI (⏰ ${task.title}):\n\n${original}`,
              );
            },
            // Slang lives on the tone passes (not Claude), so a humour task
            // gets the chat's voice here — its plain-chat output speaks the
            // group's lingo, exactly like the live flow.
            lexicon,
            // Speak the chat's persona in the rewrite too (dota → sensei).
            mode === 'dota' ? 'dota' : 'surfer',
          )
        : result.text;
      // Every other task output — a plain reminder, a surf forecast, a task the
      // admin never marked funny — still gets the chat's WORDS via the
      // vocabulary-only slang pass (facts guarded, jokes not invited). Same gate
      // as the live flow, so a chat reads consistently whoever is talking.
      const slangDecision = classifySlangDecision({
        enabled:
          isSlangPassEnabled() && modeAllowsSlang(mode) && isChatSlangEnabled(task.chatId),
        humorized: humorRan,
        toned: result.toned ?? false,
        lexiconSize: lexicon.length,
      });
      const text =
        slangDecision === 'sent'
          ? await applySlangOrOriginal(humorized, lexicon)
          : humorized;
      const prefix = task.title ? `⏰ ${task.title}\n` : '';
      const posted = prefix + text;
      await sendMarkdown(bot, task.chatId, posted);
      // Record what the task posted into conversation history so a follow-up — a
      // reply or a next-message «обнови прогноз» — has the context it refers to.
      // Without this the chat sees the recurring post but the assistant doesn't,
      // and answers blind. Stored as an assistant turn (no author); the history
      // normaliser handles the lone/back-to-back assistant turns this creates.
      addTurn({ chatId: task.chatId, role: 'assistant', tgUserId: null, content: posted });
      // …and into the raw chat log, so a later recap includes what the bot posted.
      recordChatLog({ chatId: task.chatId, role: 'assistant', tgUserId: null, content: posted });
      pruneOld(task.chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
    }
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'scheduled task run failed');
  }
}

/** Run every task whose next_run_at is due, then advance/disable its schedule. */
export async function runDueTasks(bot: Bot): Promise<void> {
  const now = Date.now();
  let tasks: ScheduledTask[];
  try {
    tasks = dueTasks(now);
  } catch (err) {
    logger.warn({ err }, 'failed to query due tasks');
    return;
  }

  for (const task of tasks) {
    await runTask(bot, task);

    // Advance the schedule regardless of run success so a failing task retries
    // next cycle instead of firing on every tick.
    const firedAt = Date.now();
    if (task.once) {
      disableTask(task.id, firedAt);
      continue;
    }
    const next = nextRunMs(task.cron, task.timezone, new Date());
    if (next === null) {
      logger.warn({ taskId: task.id }, 'no next run for recurring task; disabling');
      disableTask(task.id, firedAt);
    } else {
      setNextRun(task.id, next, firedAt);
    }
  }
}
