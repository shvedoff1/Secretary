import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The context-block hint that says the raw log EXISTS. It is the difference
// between «доступ есть только к тексту сообщений» and reading the chat back, so
// its two failure modes matter as much as the happy path: it must stay silent
// when there is genuinely nothing to point at, and it must never break a reply.

async function fresh(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.ENABLE_CHAT_LOG;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    depth: (await import('../src/summary/depth.js')).chatLogDepth,
    log: await import('../src/db/repos/chatLog.repo.js'),
    settings: await import('../src/db/repos/chatSettings.repo.js'),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
  delete process.env.ENABLE_CHAT_LOG;
});

const AUG_1 = Date.UTC(2026, 7, 1, 9, 0);
const AUG_20 = Date.UTC(2026, 7, 20, 9, 0);

describe('chat log depth hint', () => {
  it('reports how much is on record and the oldest day, in the chat timezone', async () => {
    const { depth, log, settings } = await fresh();
    settings.setTimezone(-100, 'Europe/Moscow');
    log.logMessage({ chatId: -100, role: 'user', tgUserId: 7, content: 'привет', createdAt: AUG_1 });
    log.logMessage({ chatId: -100, role: 'user', tgUserId: 8, content: 'ага', createdAt: AUG_20 });

    expect(depth(-100)).toEqual({ total: 2, oldest: '1 августа' });
  });

  it('says nothing for a chat with an empty log', async () => {
    const { depth, log } = await fresh();
    log.logMessage({ chatId: -100, role: 'user', tgUserId: 7, content: 'привет' });
    // Another chat's messages are not this chat's past.
    expect(depth(-999)).toBeNull();
  });

  it('says nothing when logging is switched off — there is no log to read back', async () => {
    const { depth, log } = await fresh({ ENABLE_CHAT_LOG: 'false' });
    // Rows may still exist from before the switch was flipped; the tool is gone,
    // so pointing the model at them would promise something it cannot do.
    log.logMessage({ chatId: -100, role: 'user', tgUserId: 7, content: 'привет' });
    expect(depth(-100)).toBeNull();
  });

  it('degrades to null instead of throwing when the read fails', async () => {
    const { depth } = await fresh();
    closeDb();
    expect(depth(-100)).toBeNull();
    // Re-open so the shared afterEach close is a no-op rather than a crash.
    ({ closeDb } = await import('../src/db/client.js'));
  });
});
