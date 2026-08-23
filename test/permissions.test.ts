import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The permission layer over the two-tier role model: supreme admins manage
// everything, chat admins exactly the chats granted to them, everyone else
// nothing. Every per-chat admin command routes through canManageChat, so this
// is the contract the whole role feature rests on.

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

describe('permissions', () => {
  it('supreme admins manage every chat; chat admins only theirs; users none', async () => {
    await freshDb();
    const users = await import('../src/db/repos/users.repo.js');
    const chatAdmins = await import('../src/db/repos/chatAdmin.repo.js');
    const perms = await import('../src/bot/permissions.js');

    users.ensureAdmin(1);
    users.upsertStatus(42, 'approved', 1);
    chatAdmins.addChatAdmin(-100, 42, 1);

    // Supreme: everything, everywhere.
    expect(perms.isSupremeAdmin(1)).toBe(true);
    expect(perms.canManageChat(1, -100)).toBe(true);
    expect(perms.canManageChat(1, -999)).toBe(true);
    expect(perms.managedChatIds(1)).toBe('all');

    // Chat admin: exactly the granted chat.
    expect(perms.isSupremeAdmin(42)).toBe(false);
    expect(perms.canManageChat(42, -100)).toBe(true);
    expect(perms.canManageChat(42, -200)).toBe(false);
    expect(perms.isBotManager(42)).toBe(true);
    expect(perms.managedChatIds(42)).toEqual([-100]);

    // Plain approved user: nothing.
    users.upsertStatus(7, 'approved', 1);
    expect(perms.canManageChat(7, -100)).toBe(false);
    expect(perms.isBotManager(7)).toBe(false);
    expect(perms.managedChatIds(7)).toEqual([]);
  });

  it('botAdminLabels names supremes first, then the chat admins, without duping', async () => {
    await freshDb();
    const users = await import('../src/db/repos/users.repo.js');
    const chatAdmins = await import('../src/db/repos/chatAdmin.repo.js');
    const perms = await import('../src/bot/permissions.js');

    users.ensureAdmin(1);
    users.upsertStatus(1, 'approved', 1, 'Швед');
    users.upsertStatus(42, 'approved', 1, 'Петя');
    chatAdmins.addChatAdmin(-100, 42, 1);
    // A supreme admin who also has a chat_admin row must not be listed twice.
    chatAdmins.addChatAdmin(-100, 1, 1);

    const labels = perms.botAdminLabels(-100);
    expect(labels).toEqual(['Швед (верховный админ)', 'Петя (админ этого чата)']);

    // Another chat: only the supremes remain.
    expect(perms.botAdminLabels(-200)).toEqual(['Швед (верховный админ)']);
  });
});
