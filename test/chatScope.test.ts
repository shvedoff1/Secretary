import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The feature split by chat kind: the calorie diary lives in the DM only,
// shared expenses (Splid / receipts) in group chats only. Each side must be
// absent — not just discouraged — where the other belongs.

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'x',
  ANTHROPIC_API_KEY: 'x',
  ADMIN_TELEGRAM_ID: '1',
  DATABASE_PATH: ':memory:',
};

let closeDb: () => void;
beforeEach(async () => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  delete process.env.ENABLE_FOOD;
  vi.resetModules();
  ({ closeDb } = await import('../src/db/client.js'));
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
});
afterEach(() => closeDb?.());

const DM = 4242;
const GROUP = -100123;

async function linkSplid(chatId: number) {
  const repo = await import('../src/db/repos/chatConfig.repo.js');
  repo.setProviderGroup({
    chatId,
    providerName: 'splid',
    credential: 'code',
    providerGroupId: 'g1',
    defaultCurrency: 'EUR',
    createdBy: 1,
  });
}

describe('chatScope', () => {
  it('reads the chat kind from the id sign', async () => {
    const s = await import('../src/core/chatScope.js');
    expect(s.isPrivateChat(DM)).toBe(true);
    expect(s.isPrivateChat(GROUP)).toBe(false);
    expect(s.foodAllowedIn(DM)).toBe(true);
    expect(s.foodAllowedIn(GROUP)).toBe(false);
    expect(s.expensesAllowedIn(DM)).toBe(false);
    expect(s.expensesAllowedIn(GROUP)).toBe(true);
  });

  it('Splid is active only in a GROUP with a linked group; a DM link stays inert', async () => {
    const s = await import('../src/core/chatScope.js');
    const scan = await import('../src/bot/expenseScan.js');
    await linkSplid(DM);
    await linkSplid(GROUP);
    expect(s.splidActiveIn(GROUP)).toBe(true);
    expect(s.splidActiveIn(DM)).toBe(false);
    expect(scan.expenseScanAllowed(DM)).toBe(false);
    expect(scan.expenseScanAllowed(GROUP)).toBe(true);
    expect(s.splidActiveIn(-555)).toBe(false); // group without a link
  });
});

describe('commands respect the split', () => {
  const fakeCtx = (chatId: number, match: string) => {
    const reply = vi.fn(async () => undefined);
    return { ctx: { chat: { id: chatId, type: chatId > 0 ? 'private' : 'group' }, from: { id: 7 }, match, reply }, reply };
  };

  it('/food in a group points to the DM and touches nothing', async () => {
    const { cmdFood } = await import('../src/bot/commands/food.js');
    const { ctx, reply } = fakeCtx(GROUP, 'goal 2000');
    await cmdFood(ctx as never);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('только в личке'));
    const repo = await import('../src/db/repos/food.repo.js');
    expect(repo.getFoodGoal(GROUP, 7)).toBeNull();
  });

  it('/group in a DM points to the group chat and links nothing', async () => {
    const { cmdGroup } = await import('../src/bot/commands/group.js');
    const { ctx, reply } = fakeCtx(DM, 'invite-code');
    await cmdGroup(ctx as never);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('в групповом чате'));
    const repo = await import('../src/db/repos/chatConfig.repo.js');
    expect(repo.getChatConfig(DM)?.provider_group_id ?? null).toBeNull();
  });
});
