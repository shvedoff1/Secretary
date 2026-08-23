import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Chat admins: the user<->chat grant table behind the two-tier role model. Each
// row gives ONE user the full per-chat toolkit for ONE chat; supreme admins
// (users.role='admin') don't need rows here at all.

async function freshDb() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('chat admin repo', () => {
  it('grants, lists and revokes per-chat admin rights', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatAdmin.repo.js');

    expect(repo.isChatAdmin(42, -100)).toBe(false);
    repo.addChatAdmin(-100, 42, 1);
    repo.addChatAdmin(-100, 43, 1);
    repo.addChatAdmin(-200, 42, 1);

    expect(repo.isChatAdmin(42, -100)).toBe(true);
    expect(repo.isChatAdmin(42, -300)).toBe(false);
    expect(repo.listChatAdmins(-100).map((a) => a.tg_user_id)).toEqual([42, 43]);
    expect(repo.listManagedChats(42)).toEqual([-100, -200]);
    expect(repo.countManagedChats(42)).toBe(2);

    expect(repo.removeChatAdmin(-100, 42)).toBe(true);
    expect(repo.removeChatAdmin(-100, 42)).toBe(false); // already gone
    expect(repo.isChatAdmin(42, -100)).toBe(false);
    expect(repo.listManagedChats(42)).toEqual([-200]);
  });

  it('a repeated grant is idempotent, not an error', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatAdmin.repo.js');
    repo.addChatAdmin(-100, 42, 1);
    repo.addChatAdmin(-100, 42, 99);
    expect(repo.listChatAdmins(-100)).toHaveLength(1);
    // The original grant (and its granted_by) survives.
    expect(repo.listChatAdmins(-100)[0]!.granted_by).toBe(1);
  });
});

describe('chat titles (chat_settings.title)', () => {
  it('records and updates a chat title for the /chats listing', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    expect(repo.getChatTitle(-100)).toBeNull();
    repo.setChatTitle(-100, 'Сёрф-чат');
    expect(repo.getChatTitle(-100)).toBe('Сёрф-чат');
    repo.setChatTitle(-100, 'Сёрф-чат 2.0');
    expect(repo.getChatTitle(-100)).toBe('Сёрф-чат 2.0');
  });

  it('listKnownChats returns every chat with a settings row', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatTitle(-100, 'Сёрф-чат');
    repo.setChatMode(-200, 'dota');
    const rows = repo.listKnownChats();
    expect(rows.map((r) => r.chat_id)).toEqual([-200, -100]);
  });
});

describe('supreme admins (users.role)', () => {
  it('grants (with approval), lists and revokes the supreme role', async () => {
    await freshDb();
    const users = await import('../src/db/repos/users.repo.js');
    users.ensureAdmin(1);

    // Granting supreme to an id the bot has never seen both sets the role AND
    // approves them — a role without whitelist access would be useless.
    users.setSupremeAdmin(55, true, 1, 'Петя');
    expect(users.isAdmin(55)).toBe(true);
    expect(users.isApproved(55)).toBe(true);
    expect(users.listSupremeAdmins().map((a) => a.tg_user_id)).toContain(55);

    // Revoking drops the role but keeps their access.
    users.setSupremeAdmin(55, false, 1);
    expect(users.isAdmin(55)).toBe(false);
    expect(users.isApproved(55)).toBe(true);
  });
});
