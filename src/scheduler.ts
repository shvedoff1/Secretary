import type { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { runAssistant } from './llm/assistant.js';
import { makeScheduleTaskHandler } from './bot/flows/assist.js';
import { appendMemory } from './db/repos/memory.repo.js';
import {
  dueTasks,
  setNextRun,
  disableTask,
  type ScheduledTask,
} from './db/repos/scheduledTask.repo.js';
import { nextRunMs } from './util/schedule.js';
import { mdToTelegramHtml, stripMarkdown } from './util/telegramHtml.js';

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
    const result = await runAssistant(
      {
        defaultCurrency: cfg.DEFAULT_CURRENCY,
        members: [],
        memory: '',
        senderName: 'scheduler',
        timezone: task.timezone,
        splidConnected: false,
        history: [],
        userContent: task.prompt,
      },
      {
        remember: (note) => (appendMemory(task.chatId, note), 'Запомнил.'),
        scheduleTask: makeScheduleTaskHandler(
          task.chatId,
          task.tgUserId ?? 0,
          cfg.DEFAULT_TIMEZONE,
        ),
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
