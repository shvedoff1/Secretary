import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { ensureAdmin } from './db/repos/users.repo.js';
import { expireOld } from './db/repos/pending.repo.js';
import { buildBot, BOT_COMMANDS } from './bot/bot.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
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
