import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The recording layer in front of the log: the global switch, the forward tag and
// the amortised trimming.
async function fresh(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const recorder = await import('../src/bot/chatLog.js');
  recorder.resetChatLogCounters();
  return { recorder, repo: await import('../src/db/repos/chatLog.repo.js') };
}

const TOUCHED = ['ENABLE_CHAT_LOG', 'CHAT_LOG_KEEP_PER_CHAT', 'CHAT_LOG_RETENTION_DAYS'];

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
  for (const key of TOUCHED) delete process.env[key];
});

describe('recordChatLog', () => {
  it('records nothing when logging is switched off', async () => {
    const { recorder, repo } = await fresh({ ENABLE_CHAT_LOG: 'false' });
    recorder.recordChatLog({ chatId: 1, role: 'user', tgUserId: 7, content: 'привет' });
    expect(repo.countLog(1)).toBe(0);
    expect(recorder.isChatLogEnabled()).toBe(false);
  });

  it('tags forwarded content so a recap does not read it as the sender speaking', async () => {
    const { recorder, repo } = await fresh();
    recorder.recordChatLog({
      chatId: 1,
      role: 'user',
      tgUserId: 7,
      senderName: 'Гоша',
      content: 'В Москве открыли мост',
      forwarded: true,
    });
    expect(repo.readLog(1, { limit: 5 })[0]!.content).toBe('[переслано] В Москве открыли мост');
  });

  it('trims the log to the configured bound as messages pile up', async () => {
    const { recorder, repo } = await fresh({ CHAT_LOG_KEEP_PER_CHAT: '5' });
    for (let i = 0; i < 60; i++) {
      recorder.recordChatLog({ chatId: 1, role: 'user', tgUserId: 7, content: `msg ${i}` });
    }
    // Trimming is amortised (once every N inserts), so the bound is the keep size
    // plus at most one batch of new lines — never the full 60.
    expect(repo.countLog(1)).toBeLessThan(20);
    // Trimming keeps the NEWEST lines.
    expect(repo.readLog(1, { limit: 5 }).at(-1)!.content).toBe('msg 59');
  });

  it('never throws when the write fails — a broken log must not break a reply', async () => {
    const { recorder } = await fresh();
    const { getDb } = await import('../src/db/client.js');
    getDb().exec('DROP TABLE chat_message_log');
    expect(() =>
      recorder.recordChatLog({ chatId: 1, role: 'user', tgUserId: 7, content: 'привет' }),
    ).not.toThrow();
  });
});
