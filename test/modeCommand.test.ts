import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// /mode and /modes — the admin side of the mode selector: read the list, switch a
// chat by word, or get the picker buttons when no mode is typed.

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

interface Reply {
  text: string;
  keyboard?: unknown;
}

function adminCtx(match: string, fromId = 1) {
  const replies: Reply[] = [];
  const ctx = {
    from: { id: fromId },
    chat: { id: fromId, type: 'private' },
    match,
    reply: async (text: string, opts?: { reply_markup?: unknown }) => {
      replies.push({ text, keyboard: opts?.reply_markup });
      return {};
    },
  } as unknown as Context;
  return { ctx, replies };
}

describe('/modes', () => {
  it('describes every mode and how to set one', async () => {
    await freshDb();
    const { cmdModes } = await import('../src/bot/commands/admin.js');
    const { MODES } = await import('../src/modes.js');

    const { ctx, replies } = adminCtx('');
    await cmdModes(ctx);
    for (const m of MODES) expect(replies[0]!.text).toContain(m.description);
    expect(replies[0]!.text).toContain('/mode <chatId>');
  });

  it('is admin-only', async () => {
    await freshDb();
    const { cmdModes } = await import('../src/bot/commands/admin.js');
    const { ctx, replies } = adminCtx('', 999);
    await cmdModes(ctx);
    expect(replies[0]!.text).not.toContain('Режимы чата:');
  });
});

describe('/mode', () => {
  it('switches a chat to the calm preset, trusts it and applies the preset defaults', async () => {
    await freshDb();
    const { cmdMode } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, replies } = adminCtx('-100500 assistant');
    await cmdMode(ctx);

    expect(repo.getChatMode(-100500)).toBe('assistant');
    expect(repo.isChatTrusted(-100500)).toBe(true);
    // The preset's tone stances became the chat's own switches.
    expect(repo.isChatHumorEnabled(-100500)).toBe(false);
    expect(repo.isChimeEnabled(-100500)).toBe(false);
    expect(repo.isReactionsEnabled(-100500)).toBe(false);
    expect(repo.isChatSlangEnabled(-100500)).toBe(true);
    expect(replies[0]!.text).toContain('спокойный');
    // The behaviour setup card follows, explaining the knobs with commands.
    const card = replies.map((r) => r.text).join('\n');
    expect(card).toContain('/humor -100500');
    expect(card).toContain('/chime -100500');
  });

  it('accepts the russian name too', async () => {
    await freshDb();
    const { cmdMode } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    await cmdMode(adminCtx('-100500 репетитор').ctx);
    expect(repo.getChatMode(-100500)).toBe('tutor');
  });

  it('accepts the new preset names (calm, funny)', async () => {
    await freshDb();
    const { cmdMode } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    await cmdMode(adminCtx('-100500 calm').ctx);
    expect(repo.getChatMode(-100500)).toBe('assistant');
    await cmdMode(adminCtx('-100500 весельчак').ctx);
    expect(repo.getChatMode(-100500)).toBe('funny');
    // The funny preset turned the jokes back on.
    expect(repo.isChatHumorEnabled(-100500)).toBe(true);
  });

  it('shows the current mode WITH the picker buttons when no mode is given', async () => {
    await freshDb();
    const { cmdMode } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(-100500, 'assistant');

    const { ctx, replies } = adminCtx('-100500');
    await cmdMode(ctx);

    expect(replies[0]!.text).toContain('спокойный');
    const kb = replies[0]!.keyboard as { inline_keyboard: { callback_data?: string }[][] };
    const data = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toContain('m:t:-100500');
    expect(data).toContain('m:?:-100500');
  });

  it('rejects an unknown mode without changing anything', async () => {
    await freshDb();
    const { cmdMode } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, replies } = adminCtx('-100500 дворецкий');
    await cmdMode(ctx);

    expect(replies[0]!.text).toContain('Такого режима нет');
    expect(repo.getChatMode(-100500)).toBe('secretary');
    expect(repo.isChatTrusted(-100500)).toBe(false);
  });
});
