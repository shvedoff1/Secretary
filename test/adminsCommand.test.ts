import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// /admins and /superadmin — the role-management commands (supreme-only, DM-only),
// plus the re-gated per-chat commands: a chat admin runs them for THEIR chats,
// and only for theirs.

async function freshDb() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
  ensureAdmin(1);
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

function dmCtx(match: string, fromId = 1, chatType = 'private') {
  const replies: string[] = [];
  const sent: { id: number; text: string }[] = [];
  const ctx = {
    from: { id: fromId },
    chat: { id: fromId, type: chatType },
    match,
    reply: async (t: string) => {
      replies.push(t);
      return {};
    },
    api: {
      sendMessage: async (id: number, text: string) => {
        sent.push({ id, text });
        return {};
      },
    },
  } as unknown as Context;
  return { ctx, replies, sent };
}

describe('/admins', () => {
  it('grants chat-admin rights (whitelisting the user) and revokes them', async () => {
    await freshDb();
    const { cmdAdmins } = await import('../src/bot/commands/admins.js');
    const chatAdmins = await import('../src/db/repos/chatAdmin.repo.js');
    const users = await import('../src/db/repos/users.repo.js');

    const add = dmCtx('-100 add 42 Петя');
    await cmdAdmins(add.ctx);
    expect(chatAdmins.isChatAdmin(42, -100)).toBe(true);
    // The grant must also open the auth gate — rights without access are useless.
    expect(users.isApproved(42)).toBe(true);
    expect(add.replies[0]).toContain('админ чата');
    // The new admin gets a heads-up DM.
    expect(add.sent[0]?.id).toBe(42);

    const list = dmCtx('-100');
    await cmdAdmins(list.ctx);
    expect(list.replies[0]).toContain('42');

    const del = dmCtx('-100 del 42');
    await cmdAdmins(del.ctx);
    expect(chatAdmins.isChatAdmin(42, -100)).toBe(false);
    // Access itself stays — only the role is revoked.
    expect(users.isApproved(42)).toBe(true);
  });

  it('is supreme-only: a chat admin cannot appoint other admins', async () => {
    await freshDb();
    const { cmdAdmins } = await import('../src/bot/commands/admins.js');
    const chatAdmins = await import('../src/db/repos/chatAdmin.repo.js');
    chatAdmins.addChatAdmin(-100, 42, 1);

    const grab = dmCtx('-100 add 43', 42);
    await cmdAdmins(grab.ctx);
    expect(chatAdmins.isChatAdmin(43, -100)).toBe(false);
    expect(grab.replies[0]).toContain('верховный');
  });
});

describe('/superadmin', () => {
  it('hands over and takes back the supreme role, protecting the root admin', async () => {
    await freshDb();
    const { cmdSuperAdmin } = await import('../src/bot/commands/admins.js');
    const users = await import('../src/db/repos/users.repo.js');

    const add = dmCtx('add 55 Петя');
    await cmdSuperAdmin(add.ctx);
    expect(users.isAdmin(55)).toBe(true);
    expect(users.isApproved(55)).toBe(true);

    // The new supreme admin can act — e.g. revoke themselves is allowed…
    const del = dmCtx('del 55', 1);
    await cmdSuperAdmin(del.ctx);
    expect(users.isAdmin(55)).toBe(false);

    // …but the configured root admin can never be demoted.
    const root = dmCtx('del 1', 1);
    await cmdSuperAdmin(root.ctx);
    expect(users.isAdmin(1)).toBe(true);
    expect(root.replies[0]).toContain('нельзя');
  });

  it('refuses non-supreme callers', async () => {
    await freshDb();
    const { cmdSuperAdmin } = await import('../src/bot/commands/admins.js');
    const users = await import('../src/db/repos/users.repo.js');

    const grab = dmCtx('add 99', 42);
    await cmdSuperAdmin(grab.ctx);
    expect(users.isAdmin(99)).toBe(false);
  });
});

describe('per-chat commands re-gated to chat admins', () => {
  it('a chat admin toggles THEIR chat, is refused on another, a user on none', async () => {
    await freshDb();
    const chatAdmins = await import('../src/db/repos/chatAdmin.repo.js');
    const { cmdHumor } = await import('../src/bot/commands/admin.js');
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    chatAdmins.addChatAdmin(-100, 42, 1);

    // Their own chat: works.
    const own = dmCtx('-100 off', 42);
    await cmdHumor(own.ctx);
    expect(settings.isChatHumorEnabled(-100)).toBe(false);

    // Someone else's chat: refused, nothing changes.
    const other = dmCtx('-200 off', 42);
    await cmdHumor(other.ctx);
    expect(settings.isChatHumorEnabled(-200)).toBe(true);
    expect(other.replies[0]).toContain('не под твоим управлением');

    // A plain user: refused outright.
    const stranger = dmCtx('-100 on', 7);
    await cmdHumor(stranger.ctx);
    expect(settings.isChatHumorEnabled(-100)).toBe(false);
  });

  it('/chats shows a chat admin exactly their chats, with tap-to-copy commands', async () => {
    await freshDb();
    const chatAdmins = await import('../src/db/repos/chatAdmin.repo.js');
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    const { cmdChats } = await import('../src/bot/commands/admin.js');
    chatAdmins.addChatAdmin(-100, 42, 1);
    settings.setChatTitle(-100, 'Сёрф-чат');
    settings.setChatTitle(-200, 'Чужой чат');

    const mine = dmCtx('', 42);
    await cmdChats(mine.ctx);
    const text = mine.replies.join('\n');
    expect(text).toContain('Сёрф-чат');
    expect(text).toContain('<code>/chat -100</code>');
    expect(text).not.toContain('Чужой чат');

    // The supreme admin sees every known chat.
    const all = dmCtx('', 1);
    await cmdChats(all.ctx);
    const allText = all.replies.join('\n');
    expect(allText).toContain('Сёрф-чат');
    expect(allText).toContain('Чужой чат');
  });

  it('the /mode picker callback obeys the per-chat gate', async () => {
    await freshDb();
    const chatAdmins = await import('../src/db/repos/chatAdmin.repo.js');
    const { handleModeCallback } = await import('../src/bot/handlers/onBotMembership.js');
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    chatAdmins.addChatAdmin(-100, 42, 1);

    const tap = (data: string, fromId: number) => {
      const answers: unknown[] = [];
      const ctx = {
        from: { id: fromId },
        callbackQuery: { data },
        answerCallbackQuery: async (a?: unknown) => {
          answers.push(a ?? {});
        },
        editMessageText: async () => ({}),
        api: { sendMessage: async () => ({}) },
      } as unknown as Context;
      return { ctx, answers };
    };

    // Chat admin on their chat: mode set.
    const ok = tap('m:a:-100', 42);
    await handleModeCallback(ok.ctx);
    expect(settings.getChatMode(-100)).toBe('assistant');

    // Chat admin on a foreign chat: rejected.
    const nope = tap('m:a:-200', 42);
    await handleModeCallback(nope.ctx);
    expect(settings.getChatMode(-200)).toBe('secretary');
  });
});
