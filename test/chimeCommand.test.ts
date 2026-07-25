import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// The admin /chime <chatId> on|off toggle (DM-only, like /trust).

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

function adminCtx(match: string, fromId = 1, chatType = 'private') {
  const replies: string[] = [];
  const ctx = {
    from: { id: fromId },
    chat: { id: fromId, type: chatType },
    match,
    reply: async (t: string) => {
      replies.push(t);
      return {};
    },
  } as unknown as Context;
  return { ctx, replies };
}

describe('/chime command', () => {
  it('turns the chime off and back on for a specific chat', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdChime } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const off = adminCtx('-500 off');
    await cmdChime(off.ctx);
    expect(repo.isChimeEnabled(-500)).toBe(false);
    expect(off.replies[0]).toContain('выключены');

    const status = adminCtx('-500');
    await cmdChime(status.ctx);
    expect(status.replies[0]).toContain('ВЫКЛ');

    const on = adminCtx('-500 on');
    await cmdChime(on.ctx);
    expect(repo.isChimeEnabled(-500)).toBe(true);
  });

  it('rejects non-admins and bad usage', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdChime } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const stranger = adminCtx('-500 off', 999);
    await cmdChime(stranger.ctx);
    expect(repo.isChimeEnabled(-500)).toBe(true); // nothing changed

    const bad = adminCtx('-500 maybe');
    await cmdChime(bad.ctx);
    expect(bad.replies[0]).toContain('Использование');
    expect(repo.isChimeEnabled(-500)).toBe(true);
  });
});
