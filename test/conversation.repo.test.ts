import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fresh in-memory DB per test; repo imported after env + module reset so it binds
// to the freshly-opened database.
async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const repo = await import('../src/db/repos/conversation.repo.js');
  const { getDb } = await import('../src/db/client.js');
  return { repo, db: getDb() };
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('conversation repo', () => {
  it('returns recent turns in chronological order', async () => {
    const { repo } = await fresh();
    repo.addTurn({ chatId: 1, role: 'user', tgUserId: 7, content: 'привет' });
    repo.addTurn({ chatId: 1, role: 'assistant', tgUserId: null, content: 'здаров' });

    expect(repo.recentTurns(1, 20).map((t) => [t.role, t.content])).toEqual([
      ['user', 'привет'],
      ['assistant', 'здаров'],
    ]);
  });

  it('excludes turns older than the age cutoff but keeps fresh ones', async () => {
    const { repo, db } = await fresh();
    // An old off-topic exchange...
    repo.addTurn({ chatId: 1, role: 'user', tgUserId: 7, content: 'разгон про драконов' });
    repo.addTurn({ chatId: 1, role: 'assistant', tgUserId: null, content: 'ну такое' });
    // ...backdated two days into the past.
    db.prepare('UPDATE conversation_turn SET created_at = ? WHERE chat_id = 1').run(Date.now() - 2 * DAY);

    // A fresh exchange.
    repo.addTurn({ chatId: 1, role: 'user', tgUserId: 7, content: 'что по погоде' });
    repo.addTurn({ chatId: 1, role: 'assistant', tgUserId: null, content: 'солнечно' });

    // With a 12h window the old tangent is gone.
    expect(repo.recentTurns(1, 20, 12 * HOUR).map((t) => t.content)).toEqual([
      'что по погоде',
      'солнечно',
    ]);

    // Without a cutoff, the count-only window still surfaces the old turns.
    expect(repo.recentTurns(1, 20)).toHaveLength(4);
  });

  it('keeps history per-chat and clears only the given chat', async () => {
    const { repo } = await fresh();
    repo.addTurn({ chatId: 1, role: 'user', tgUserId: 7, content: 'a' });
    repo.addTurn({ chatId: 2, role: 'user', tgUserId: 8, content: 'b' });
    repo.clearTurns(1);
    expect(repo.recentTurns(1, 20)).toHaveLength(0);
    expect(repo.recentTurns(2, 20)).toHaveLength(1);
  });
});
