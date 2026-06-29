import { describe, it, expect, vi } from 'vitest';

/**
 * Migration 010 backfills the legacy single-blob `chat_memory` into the new
 * weighted `chat_memory_item` store as one pinned chat-scope item, so nothing
 * previously remembered is lost. We simulate a pre-010 DB (schema_version = 9 with
 * the old chat_memory table populated), then run migrate() and check the backfill.
 */
describe('migration 010 memory backfill', () => {
  it('carries an existing chat_memory blob over as a pinned chat item', async () => {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();

    const { getDb, closeDb } = await import('../src/db/client.js');
    const db = getDb();

    // Pre-010 state: the legacy table exists with a blob, recorded at v9. We also
    // create scheduled_task (present since migration 004) so later migrations that
    // alter it (e.g. 011's humor column) can run against this synthetic v9 DB.
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version (version) VALUES (9)').run();
    db.exec(
      `CREATE TABLE chat_memory (
         chat_id INTEGER PRIMARY KEY,
         content TEXT NOT NULL DEFAULT '',
         updated_at INTEGER NOT NULL
       )`,
    );
    db.exec(
      `CREATE TABLE scheduled_task (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         chat_id     INTEGER NOT NULL,
         tg_user_id  INTEGER,
         title       TEXT NOT NULL,
         prompt      TEXT NOT NULL,
         cron        TEXT NOT NULL,
         timezone    TEXT NOT NULL,
         once        INTEGER NOT NULL DEFAULT 0,
         enabled     INTEGER NOT NULL DEFAULT 1,
         next_run_at INTEGER NOT NULL,
         last_run_at INTEGER,
         created_at  INTEGER NOT NULL
       )`,
    );
    db.prepare('INSERT INTO chat_memory (chat_id, content, updated_at) VALUES (?, ?, ?)').run(
      555,
      '- любит кофе\n- часовой пояс Bali',
      123,
    );
    // A blank blob must NOT be backfilled.
    db.prepare('INSERT INTO chat_memory (chat_id, content, updated_at) VALUES (?, ?, ?)').run(
      556,
      '   ',
      123,
    );

    const { migrate } = await import('../src/db/migrate.js');
    migrate(); // applies only 010 (applied = 9)

    const rows = db
      .prepare(`SELECT chat_id, scope, content, source FROM chat_memory_item`)
      .all() as { chat_id: number; scope: string; content: string; source: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chat_id: 555,
      scope: 'chat',
      source: 'explicit',
      content: '- любит кофе\n- часовой пояс Bali',
    });

    closeDb();
  });
});
