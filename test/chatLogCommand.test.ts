import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// The admin /chatlog <chatId> [clear] command: see how far the raw log reaches,
// and wipe it (DM-only, like the other per-chat admin commands).

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
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
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

describe('/chatlog command', () => {
  it('reports how much is logged and clears it on demand', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdChatLog } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatLog.repo.js');
    repo.logMessage({ chatId: -500, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'а' });
    repo.logMessage({ chatId: -500, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'б' });

    const status = adminCtx('-500');
    await cmdChatLog(status.ctx);
    expect(status.replies[0]).toContain('2 сообщени');

    const cleared = adminCtx('-500 clear');
    await cmdChatLog(cleared.ctx);
    expect(repo.countLog(-500)).toBe(0);
    expect(cleared.replies[0]).toContain('очищен');
  });

  it('refuses non-admins and bad usage', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdChatLog } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatLog.repo.js');
    repo.logMessage({ chatId: -500, role: 'user', tgUserId: 7, content: 'а' });

    const stranger = adminCtx('-500 clear', 999);
    await cmdChatLog(stranger.ctx);
    expect(repo.countLog(-500)).toBe(1);

    const noId = adminCtx('');
    await cmdChatLog(noId.ctx);
    expect(noId.replies[0]).toContain('Использование');
  });
});
