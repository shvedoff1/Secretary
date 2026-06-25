import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { ensureAdmin } from './db/repos/users.repo.js';
import { expireOld } from './db/repos/pending.repo.js';
import { buildBot, BOT_COMMANDS } from './bot/bot.js';
import { runDueTasks } from './scheduler.js';
import { runDailySpendingReports } from './spending/daily.js';
import { flushStaleLexicons } from './bot/flows/lexicon.js';
import { isHumorEnabled } from './llm/humorize.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Log resolved feature flags at startup (no secrets) so a deploy can be
  // verified from the logs. `humor` is true only when the flag is on AND an
  // OpenAI key is present — exactly the condition for the humorizer to run.
  const humor = isHumorEnabled();
  logger.info(
    {
      model: cfg.ANTHROPIC_MODEL,
      webSearch: cfg.ENABLE_WEB_SEARCH,
      surf: cfg.ENABLE_SURF,
      humor,
      humorModel: humor ? cfg.OPENAI_HUMOR_MODEL : undefined,
    },
    'startup config',
  );

  migrate();
  ensureAdmin(cfg.ADMIN_TELEGRAM_ID);

  const bot = buildBot(cfg.BOT_TOKEN);

  // Periodically expire stale pending previews.
  const sweeper = setInterval(() => {
    try {
      const n = expireOld(cfg.PENDING_TTL_MINUTES);
      if (n > 0) logger.debug({ n }, 'expired pending previews');
    } catch (err) {
      logger.warn({ err }, 'pending sweep failed');
    }
  }, 5 * 60_000);
  sweeper.unref();

  // Fire due reminders / recurring tasks every minute, and post any due daily
  // spending digests.
  const scheduler = setInterval(() => {
    void runDueTasks(bot).catch((err) => {
      logger.warn({ err }, 'scheduler tick failed');
    });
    void runDailySpendingReports(bot).catch((err) => {
      logger.warn({ err }, 'daily spending tick failed');
    });
  }, 60_000);
  scheduler.unref();

  // Catch-up extraction for chats that went quiet before filling a batch, so the
  // "once a day" lexicon trigger still fires. Best-effort; the per-message path
  // handles active chats.
  const lexiconFlusher = setInterval(() => {
    void flushStaleLexicons().catch((err) => {
      logger.warn({ err }, 'lexicon flush tick failed');
    });
  }, 60 * 60_000);
  lexiconFlusher.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    clearInterval(scheduler);
    clearInterval(lexiconFlusher);
    await bot.stop();
    closeDb();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start({
    onStart: async (info) => {
      logger.info({ username: info.username }, 'bot started (long polling)');
      try {
        await bot.api.setMyCommands(BOT_COMMANDS);
      } catch (err) {
        logger.warn({ err }, 'could not set command menu');
      }
    },
  });
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
