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
import { mdToTelegramHtml, stripMarkdown } from './util/telegramHtml.js';
import { makeSurfForecastHandler } from './surf/index.js';
import { makeSpendingReportHandler } from './spending/handler.js';
import { getProvider } from './core/registry.js';
import { getChatConfig } from './db/repos/chatConfig.repo.js';
import { getMemoryForContext } from './db/repos/memoryItem.repo.js';
import type { Member } from './core/types.js';
import type { Config } from './config.js';

const surfForecast = makeSurfForecastHandler();

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
  });
  return {
    memoryChat: sel.chat.map((i) => ({ content: i.content })),
    memoryUsers: sel.users.map((u) => ({
      subject: u.subject,
      items: u.items.map((i) => ({ content: i.content })),
    })),
  };
}

async function sendMarkdown(bot: Bot, chatId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, mdToTelegramHtml(text), { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn({ err, chatId }, 'scheduled HTML send failed, falling back to plain');
    await bot.api.sendMessage(chatId, stripMarkdown(text));
  }
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
    const { memoryChat, memoryUsers } = scheduledMemory(task.chatId, task.tgUserId, cfg);

    const result = await runAssistant(
      {
        defaultCurrency: chatCfg?.default_currency ?? cfg.DEFAULT_CURRENCY,
        members: members.map((m) => ({ name: m.name, initials: m.initials })),
        memoryChat,
        memoryUsers,
        senderName: 'scheduler',
        timezone: task.timezone,
        splidConnected: !!chatCfg?.provider_group_id,
        // A firing reminder just produces text (optionally via web search). It must
        // NOT be able to create reminders or write memory — otherwise a reminder
        // could spawn more reminders every time it runs.
        allowRemember: false,
        allowExpenseLearning: false,
        allowReminders: false,
        allowPoi: false,
        history: [],
        userContent: task.prompt,
      },
      {
        remember: () => 'noop',
        learnExpense: () => 'noop',
        scheduleTask: () => 'noop',
        // Surf forecast stays live: a recurring evening task asks for tomorrow's
        // forecast and the bot posts the recommendation to the chat.
        surfForecast,
        addPoi: () => 'noop',
        // Spending report stays live too: a recurring task can post the daily
        // spending digest (it short-circuits to ready, humorized text).
        spendingReport: makeSpendingReportHandler(task.chatId),
      },
    );
    if (result.kind === 'text' && result.text.trim()) {
      const prefix = task.title ? `⏰ ${task.title}\n` : '';
      await sendMarkdown(bot, task.chatId, prefix + result.text);
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
