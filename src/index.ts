import { run } from '@grammyjs/runner';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { ensureAdmin } from './db/repos/users.repo.js';
import { expireOld } from './db/repos/pending.repo.js';
import { buildBot, BOT_COMMANDS } from './bot/bot.js';
import { runDueTasks } from './scheduler.js';
import { runDueWatches } from './watch/poller.js';
import { runDueDotaSync } from './dota/sync.js';
import { flushStaleLexicons } from './bot/flows/lexicon.js';
import { flushStaleMemories } from './bot/flows/memory.js';
import { isHumorEnabled } from './llm/humorize.js';
import { isSlangPassEnabled } from './llm/slang.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Log resolved feature flags at startup (no secrets) so a deploy can be
  // verified from the logs. `humor` is true only when the flag is on AND an
  // OpenAI key is present — exactly the condition for the humorizer to run.
  const humor = isHumorEnabled();
  // Same shape for the slang pass: on only with the flag AND an OpenAI key.
  const slangPass = isSlangPassEnabled();
  logger.info(
    {
      model: cfg.ANTHROPIC_MODEL,
      webSearch: cfg.ENABLE_WEB_SEARCH,
      surf: cfg.ENABLE_SURF,
      memory: cfg.ENABLE_MEMORY,
      watch: cfg.ENABLE_WATCH,
      dota: cfg.ENABLE_DOTA,
      humor,
      humorModel: humor ? cfg.OPENAI_HUMOR_MODEL : undefined,
      slang: slangPass,
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

  // Fire due reminders / recurring tasks every minute; page watches poll on the
  // same tick (each watch keeps its own next-check time, so the minute tick is
  // just the heartbeat).
  const scheduler = setInterval(() => {
    void runDueTasks(bot).catch((err) => {
      logger.warn({ err }, 'scheduler tick failed');
    });
    void runDueWatches(bot).catch((err) => {
      logger.warn({ err }, 'watch tick failed');
    });
  }, 60_000);
  scheduler.unref();

  // Catch-up extraction for chats that went quiet before filling a batch, so the
  // "once a day" lexicon/memory triggers still fire. Best-effort; the per-message
  // path handles active chats.
  const lexiconFlusher = setInterval(() => {
    void flushStaleLexicons().catch((err) => {
      logger.warn({ err }, 'lexicon flush tick failed');
    });
    void flushStaleMemories().catch((err) => {
      logger.warn({ err }, 'memory flush tick failed');
    });
    // The Dota knowledge base decides for itself whether anything is due (a
    // once-a-day probe, a crawl only at night or when the patch moved), so the
    // hourly heartbeat is all it needs.
    void runDueDotaSync();
  }, 60 * 60_000);
  lexiconFlusher.unref();

  // Startup catch-up: an empty base would leave the dota chat unanswerable until
  // the night hour, so the first boot (and any boot with no data) syncs now.
  void runDueDotaSync();

  // Concurrent long polling: the runner processes updates concurrently instead of
  // one-at-a-time, so a slow LLM turn in one chat no longer blocks every other chat.
  // Per-chat ordering is preserved by the `sequentialize` middleware (see bot.ts).
  const runner = run(bot);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    clearInterval(scheduler);
    clearInterval(lexiconFlusher);
    if (runner.isRunning()) await runner.stop();
    closeDb();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const me = await bot.api.getMe();
    logger.info({ username: me.username }, 'bot started (concurrent long polling)');
    await bot.api.setMyCommands(BOT_COMMANDS);
  } catch (err) {
    logger.warn({ err }, 'could not set command menu');
  }

  // Keep the process alive until the runner stops (SIGINT/SIGTERM → shutdown()).
  await runner.task();
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
