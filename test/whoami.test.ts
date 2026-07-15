import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'grammy';

vi.mock('../src/db/repos/users.repo.js', () => ({
  getUser: vi.fn(() => ({ role: 'user', status: 'approved' })),
}));
vi.mock('../src/db/repos/memberMap.repo.js', () => ({
  getMapping: vi.fn(() => undefined),
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
    // copy it into /mode <chatId> tutor.
    const { c, reply } = ctx(-100123);
    await cmdWhoami(c);
    const text = reply.mock.calls[0]![0] as string;
    expect(text).toContain('чат: -100123');
    expect(text).toContain('id: 42');
  });
});
