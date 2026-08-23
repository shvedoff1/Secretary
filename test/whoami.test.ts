import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'grammy';

vi.mock('../src/db/repos/users.repo.js', () => ({
  getUser: vi.fn(() => ({ role: 'user', status: 'approved' })),
  isAdmin: vi.fn(() => false),
  listSupremeAdmins: vi.fn(() => []),
}));
vi.mock('../src/db/repos/memberMap.repo.js', () => ({
  getMapping: vi.fn(() => undefined),
}));
vi.mock('../src/db/repos/chatAdmin.repo.js', () => ({
  listManagedChats: vi.fn(() => []),
  listChatAdmins: vi.fn(() => []),
  countManagedChats: vi.fn(() => 0),
  isChatAdmin: vi.fn(() => false),
}));
vi.mock('../src/db/repos/chatSettings.repo.js', () => ({
  getChatTitle: vi.fn(() => null),
}));
vi.mock('../src/db/repos/chatConfig.repo.js', () => ({
  getChatConfig: vi.fn(() => undefined),
}));

import { cmdWhoami } from '../src/bot/commands/whoami.js';

function ctx(chatId: number): { c: Context; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn(async () => undefined);
  const c = {
    from: { id: 42, username: 'kid' },
    chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' },
    reply,
  } as unknown as Context;
  return { c, reply };
}

describe('/whoami', () => {
  it('shows the chat id — the handle admin commands like /mode need', async () => {
    // A group id is negative; that exact value must be printed so the admin can
    // copy it into /mode <chatId> tutor. Ids are wrapped in <code> so a tap
    // copies them (the reply is parse_mode: HTML).
    const { c, reply } = ctx(-100123);
    await cmdWhoami(c);
    const text = reply.mock.calls[0]![0] as string;
    expect(text).toContain('чат: <code>-100123</code>');
    expect(text).toContain('id: <code>42</code>');
    expect(text).toContain('роль: участник');
    const opts = reply.mock.calls[0]![1] as { parse_mode?: string };
    expect(opts?.parse_mode).toBe('HTML');
  });
});
