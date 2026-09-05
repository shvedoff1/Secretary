import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// /setcurrency — two entry points (DM cross-chat form, in-chat implied-id form),
// and validation against real ISO 4217 codes: an invented code used to be stored
// verbatim, so every expense reached Splid with a currency it doesn't know.

const CHAT = -100500;

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
  // A Splid-connected chat to point the command at.
  const { setProviderGroup } = await import('../src/db/repos/chatConfig.repo.js');
  setProviderGroup({
    chatId: CHAT,
    providerName: 'splid',
    credential: 'code',
    providerGroupId: 'g1',
    defaultCurrency: 'EUR',
    createdBy: 1,
  });
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

function makeCtx(match: string, fromId: number, chat: { id: number; type: string }) {
  const replies: string[] = [];
  const ctx = {
    from: { id: fromId },
    chat,
    match,
    reply: async (t: string) => {
      replies.push(t);
      return {};
    },
  } as unknown as Context;
  return { ctx, replies };
}

const dm = (match: string, fromId = 1) => makeCtx(match, fromId, { id: fromId, type: 'private' });
const group = (match: string, fromId: number) => makeCtx(match, fromId, { id: CHAT, type: 'supergroup' });

async function currencyOf(chatId: number): Promise<string | undefined> {
  const { getChatConfig } = await import('../src/db/repos/chatConfig.repo.js');
  return getChatConfig(chatId)?.default_currency;
}

describe('/setcurrency from the DM', () => {
  it('sets a real currency (uppercased)', async () => {
    await freshDb();
    const { cmdSetCurrency } = await import('../src/bot/commands/admin.js');
    const { ctx, replies } = dm(`${CHAT} vnd`);
    await cmdSetCurrency(ctx);
    expect(await currencyOf(CHAT)).toBe('VND');
    expect(replies[0]).toContain('VND');
  });

  it('rejects a nonexistent currency and changes nothing', async () => {
    await freshDb();
    const { cmdSetCurrency } = await import('../src/bot/commands/admin.js');
    const { ctx, replies } = dm(`${CHAT} ZZZ`);
    await cmdSetCurrency(ctx);
    expect(await currencyOf(CHAT)).toBe('EUR');
    expect(replies[0]).toContain('ZZZ');
    expect(replies[0]).toContain('ISO 4217');
  });
});

describe('/setcurrency in the chat itself', () => {
  it('lets the chat’s admin set the currency with the id implied', async () => {
    await freshDb();
    const { cmdSetCurrency } = await import('../src/bot/commands/admin.js');
    const { ctx, replies } = group('idr', 1);
    await cmdSetCurrency(ctx);
    expect(await currencyOf(CHAT)).toBe('IDR');
    expect(replies[0]).toContain('IDR');
  });

  it('accepts an explicit id only when it names this same chat', async () => {
    await freshDb();
    const { cmdSetCurrency } = await import('../src/bot/commands/admin.js');
    const same = group(`${CHAT} USD`, 1);
    await cmdSetCurrency(same.ctx);
    expect(await currencyOf(CHAT)).toBe('USD');

    // Another chat's id from a group would leak/change foreign config — DM only.
    const other = group('-200 EUR', 1);
    await cmdSetCurrency(other.ctx);
    expect(other.replies[0]).toContain('из лички');
    expect(await currencyOf(CHAT)).toBe('USD');
  });

  it('refuses a non-admin member', async () => {
    await freshDb();
    const { cmdSetCurrency } = await import('../src/bot/commands/admin.js');
    const { ctx, replies } = group('USD', 42);
    await cmdSetCurrency(ctx);
    expect(await currencyOf(CHAT)).toBe('EUR');
    expect(replies[0]).toContain('админ');
  });

  it('validates the code in the chat too', async () => {
    await freshDb();
    const { cmdSetCurrency } = await import('../src/bot/commands/admin.js');
    const { ctx, replies } = group('QQQ', 1);
    await cmdSetCurrency(ctx);
    expect(await currencyOf(CHAT)).toBe('EUR');
    expect(replies[0]).toContain('ISO 4217');
  });

  it('a chat admin (not supreme) can set their chat’s currency in that chat', async () => {
    await freshDb();
    const { addChatAdmin } = await import('../src/db/repos/chatAdmin.repo.js');
    addChatAdmin(CHAT, 42, 1);
    const { cmdSetCurrency } = await import('../src/bot/commands/admin.js');
    const { ctx } = group('rub', 42);
    await cmdSetCurrency(ctx);
    expect(await currencyOf(CHAT)).toBe('RUB');
  });
});
