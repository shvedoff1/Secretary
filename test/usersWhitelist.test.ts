import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/users.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('whitelist upsertStatus', () => {
  it('whitelists an id the bot has never seen (proactive /allow)', async () => {
    const repo = await freshRepo();
    // The old setStatus was UPDATE-only: for an unknown id it silently did nothing.
    repo.upsertStatus(555, 'approved', 1, 'Мелкий');
    expect(repo.isApproved(555)).toBe(true);
    expect(repo.getUser(555)?.display_name).toBe('Мелкий');
  });

  it('revokes access for an existing user without losing their profile', async () => {
    const repo = await freshRepo();
    const u = repo.requestAccess(555, 'kid', 'Мелкий');
    expect(u.status).toBe('pending');
    repo.upsertStatus(555, 'approved', 1);
    expect(repo.isApproved(555)).toBe(true);
    repo.upsertStatus(555, 'denied', 1);
    expect(repo.isApproved(555)).toBe(false);
    // username/display_name survive the decision flip.
    expect(repo.getUser(555)?.username).toBe('kid');
    expect(repo.getUser(555)?.display_name).toBe('Мелкий');
  });

  it('keeps an existing display name when /allow passes none', async () => {
    const repo = await freshRepo();
    repo.requestAccess(555, null, 'Мелкий');
    repo.upsertStatus(555, 'approved', 1);
    expect(repo.getUser(555)?.display_name).toBe('Мелкий');
  });

  it('never downgrades the admin role', async () => {
    const repo = await freshRepo();
    repo.ensureAdmin(1);
    repo.upsertStatus(1, 'approved', 1, 'Я');
    expect(repo.isAdmin(1)).toBe(true);
  });
});

describe('whitelist listUsers', () => {
  it('lists approved first, then pending, then denied', async () => {
    const repo = await freshRepo();
    repo.requestAccess(10, null, 'Ждёт');
    repo.upsertStatus(20, 'denied', 1, 'Забанен');
    repo.upsertStatus(30, 'approved', 1, 'Свой');
    const got = repo.listUsers().map((u) => u.tg_user_id);
    expect(got).toEqual([30, 10, 20]);
  });
});
