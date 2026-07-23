import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context, NextFunction } from 'grammy';

// Covers the whole-chat trust story: the auth gate's trusted-chat exemption, the
// trusted flag round-trip, and the "bot was added → admin picks a mode" flow.

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

describe('chat trusted flag', () => {
  it('defaults to not trusted and round-trips', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    expect(repo.isChatTrusted(5)).toBe(false);
    repo.setChatTrusted(5, true);
    expect(repo.isChatTrusted(5)).toBe(true);
    repo.setChatTrusted(5, false);
    expect(repo.isChatTrusted(5)).toBe(false);
  });

  it('does not clobber mode or timezone (all live in chat_settings)', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(5, 'dota');
    repo.setTimezone(5, 'Europe/Moscow');
    repo.setChatTrusted(5, true);
    expect(repo.getChatMode(5)).toBe('dota');
    expect(repo.getTimezone(5)).toBe('Europe/Moscow');
    expect(repo.isChatTrusted(5)).toBe(true);
  });
});

function gateCtx(over: Partial<Record<string, unknown>> = {}) {
  const replies: string[] = [];
  const ctx = {
    from: { id: 999 }, // not whitelisted
    chat: { id: 5, type: 'supergroup' },
    message: { text: 'го катать' },
    reply: async (t: string) => {
      replies.push(t);
      return {};
    },
    ...over,
  } as unknown as Context;
  return { ctx, replies };
}

describe('authGate trusted-chat exemption', () => {
  it('blocks an unapproved user in an untrusted, unconfigured group (silently)', async () => {
    await freshDb();
    const { authGate } = await import('../src/bot/middleware/auth.js');
    const next = vi.fn(async () => {}) as unknown as NextFunction;
    const { ctx, replies } = gateCtx();
    await authGate(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(replies).toEqual([]); // group blocks are silent
  });

  it('passes any participant of a trusted group', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatTrusted(5, true);
    const { authGate } = await import('../src/bot/middleware/auth.js');
    const next = vi.fn(async () => {}) as unknown as NextFunction;
    const { ctx } = gateCtx();
    await authGate(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('trust in one chat does not open another', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatTrusted(5, true);
    const { authGate } = await import('../src/bot/middleware/auth.js');
    const next = vi.fn(async () => {}) as unknown as NextFunction;
    const { ctx } = gateCtx({ chat: { id: 6, type: 'supergroup' } });
    await authGate(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('still protects private chats: trust never applies to DMs', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatTrusted(999, true); // even a "trusted" id…
    const { authGate } = await import('../src/bot/middleware/auth.js');
    const next = vi.fn(async () => {}) as unknown as NextFunction;
    const { ctx, replies } = gateCtx({ chat: { id: 999, type: 'private' } });
    await authGate(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(replies[0]).toContain('/request'); // DM gets the nudge
  });
});

// --- the "bot was added" onboarding -----------------------------------------

interface Sent {
  chatId: number;
  text: string;
  hasKeyboard: boolean;
}

function membershipCtx(args: {
  oldStatus: string;
  newStatus: string;
  chatType?: string;
}): { ctx: Context; sent: Sent[] } {
  const sent: Sent[] = [];
  const ctx = {
    myChatMember: {
      chat: { id: -100500, type: args.chatType ?? 'supergroup', title: 'Дота тусовка' },
      from: { id: 777, first_name: 'Вася' },
      old_chat_member: { status: args.oldStatus },
      new_chat_member: { status: args.newStatus },
    },
    api: {
      sendMessage: async (chatId: number, text: string, extra?: { reply_markup?: unknown }) => {
        sent.push({ chatId, text, hasKeyboard: !!extra?.reply_markup });
        return {};
      },
    },
  } as unknown as Context;
  return { ctx, sent };
}

describe('onBotMembership', () => {
  it('DMs the admin with the chat info and the mode picker when the bot joins', async () => {
    await freshDb();
    const { onBotMembership } = await import('../src/bot/handlers/onBotMembership.js');
    const { ctx, sent } = membershipCtx({ oldStatus: 'left', newStatus: 'member' });
    await onBotMembership(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(1); // ADMIN_TELEGRAM_ID
    expect(sent[0]!.text).toContain('Дота тусовка');
    expect(sent[0]!.text).toContain('-100500');
    expect(sent[0]!.hasKeyboard).toBe(true);
  });

  it('revokes trust and notifies the admin when the bot is removed', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatTrusted(-100500, true);
    const { onBotMembership } = await import('../src/bot/handlers/onBotMembership.js');
    const { ctx, sent } = membershipCtx({ oldStatus: 'member', newStatus: 'kicked' });
    await onBotMembership(ctx);

    expect(repo.isChatTrusted(-100500)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('удалили');
  });

  it('ignores promotions and private chats', async () => {
    await freshDb();
    const { onBotMembership } = await import('../src/bot/handlers/onBotMembership.js');
    const promo = membershipCtx({ oldStatus: 'member', newStatus: 'administrator' });
    await onBotMembership(promo.ctx);
    expect(promo.sent).toHaveLength(0);

    const dm = membershipCtx({ oldStatus: 'left', newStatus: 'member', chatType: 'private' });
    await onBotMembership(dm.ctx);
    expect(dm.sent).toHaveLength(0);
  });
});

// --- the mode-picker callback ------------------------------------------------

function callbackCtx(data: string, fromId: number) {
  const sent: Sent[] = [];
  const answers: unknown[] = [];
  const edits: string[] = [];
  const ctx = {
    from: { id: fromId },
    chat: { id: fromId, type: 'private' },
    callbackQuery: { data },
    answerCallbackQuery: async (a?: unknown) => {
      answers.push(a ?? {});
      return true;
    },
    editMessageText: async (text: string) => {
      edits.push(text);
      return {};
    },
    api: {
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text, hasKeyboard: false });
        return {};
      },
    },
  } as unknown as Context;
  return { ctx, sent, answers, edits };
}

describe('handleModeCallback', () => {
  it('one tap on «дота»: sets the mode, trusts the chat, greets the squad', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { handleModeCallback } = await import('../src/bot/handlers/onBotMembership.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, sent, edits } = callbackCtx('m:d:-100500', 1);
    await handleModeCallback(ctx);

    expect(repo.getChatMode(-100500)).toBe('dota');
    expect(repo.isChatTrusted(-100500)).toBe(true);
    // The admin DM is updated and the chat gets the sensei greeting with /ping.
    expect(edits[0]).toContain('доступ открыт');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(-100500);
    expect(sent[0]!.text).toContain('/ping');
  });

  it('«игнорить» leaves the chat untrusted', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { handleModeCallback } = await import('../src/bot/handlers/onBotMembership.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, sent } = callbackCtx('m:x:-100500', 1);
    await handleModeCallback(ctx);

    expect(repo.isChatTrusted(-100500)).toBe(false);
    expect(sent).toHaveLength(0); // no greeting in an ignored chat
  });

  it('rejects a non-admin tap', async () => {
    await freshDb();
    const { handleModeCallback } = await import('../src/bot/handlers/onBotMembership.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, answers } = callbackCtx('m:d:-100500', 999);
    await handleModeCallback(ctx);

    expect(repo.isChatTrusted(-100500)).toBe(false);
    expect(repo.getChatMode(-100500)).toBe('secretary');
    expect(answers[0]).toMatchObject({ text: 'Только администратор.' });
  });

  it('a greeting failure does not roll back the mode/trust', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { handleModeCallback } = await import('../src/bot/handlers/onBotMembership.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx } = callbackCtx('m:s:-100500', 1);
    (ctx as unknown as { api: { sendMessage: () => Promise<never> } }).api.sendMessage =
      async () => {
        throw new Error('bot was kicked');
      };
    await handleModeCallback(ctx);

    expect(repo.getChatMode(-100500)).toBe('secretary');
    expect(repo.isChatTrusted(-100500)).toBe(true);
  });
});
