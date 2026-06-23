import { describe, it, expect, vi } from 'vitest';

/**
 * End-to-end check that migration 007 widens the pending_expense source CHECK
 * constraint to accept 'voice' (and still rejects unknown sources).
 */
describe('pending_expense voice source', () => {
  it('accepts voice and rejects unknown sources after migrating', async () => {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();

    const { getDb, closeDb } = await import('../src/db/client.js');
    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    const db = getDb();

    const insert = (id: string, source: string) =>
      db
        .prepare(
          `INSERT INTO pending_expense (id, chat_id, tg_user_id, draft_json, source, status, created_at)
           VALUES (?, 1, 1, '{}', ?, 'awaiting', 0)`,
        )
        .run(id, source);

    insert('a', 'voice');
    const row = db.prepare("SELECT source FROM pending_expense WHERE id = 'a'").get() as {
      source: string;
    };
    expect(row.source).toBe('voice');

    insert('b', 'text');
    expect(() => insert('c', 'bogus')).toThrow();

    closeDb();
  });
});
