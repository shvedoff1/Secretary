import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// The per-chat slang switch: the repo column, the `/slang on|off` command that
// drives it, and `getVoiceLexicon` — the one helper every tone pass reads the
// lexicon through, so the switch can't be honoured in one place and forgotten
// in another.

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

function ctxFor(match: string, opts: { fromId?: number; chatId?: number } = {}) {
  const replies: string[] = [];
  const ctx = {
    from: { id: opts.fromId ?? 1 },
    chat: { id: opts.chatId ?? opts.fromId ?? 1, type: 'private' },
    match,
    reply: async (t: string) => {
      replies.push(t);
      return {};
    },
  } as unknown as Context;
  return { ctx, replies };
}

describe('chat slang setting', () => {
  it('defaults to ON for a chat with no settings row', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    expect(repo.isChatSlangEnabled(-500)).toBe(true);
  });

  it('round-trips off and back on without clobbering neighbours', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatHumorEnabled(-500, false);
    repo.setTimezone(-500, 'Asia/Makassar');

    repo.setChatSlangEnabled(-500, false);
    expect(repo.isChatSlangEnabled(-500)).toBe(false);
    // Independent of the humour switch — that's the whole point.
    expect(repo.isChatHumorEnabled(-500)).toBe(false);
    expect(repo.getTimezone(-500)).toBe('Asia/Makassar');

    repo.setChatSlangEnabled(-500, true);
    expect(repo.isChatSlangEnabled(-500)).toBe(true);
  });

  it('is per chat', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatSlangEnabled(-500, false);
    expect(repo.isChatSlangEnabled(-501)).toBe(true);
  });
});

describe('getVoiceLexicon', () => {
  it('returns the learned terms when slang is on', async () => {
    await freshDb();
    const lex = await import('../src/db/repos/lexicon.repo.js');
    lex.recordTerms(-500, [{ term: 'катка', gloss: 'игра' }]);
    expect(lex.getVoiceLexicon(-500)).toEqual([{ term: 'катка', gloss: 'игра' }]);
  });

  it('returns nothing when the chat has slang switched off (learning untouched)', async () => {
    await freshDb();
    const lex = await import('../src/db/repos/lexicon.repo.js');
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    lex.recordTerms(-500, [{ term: 'катка', gloss: 'игра' }]);
    settings.setChatSlangEnabled(-500, false);

    expect(lex.getVoiceLexicon(-500)).toEqual([]);
    // The words are still learned and still visible via /slang — only their
    // APPLICATION to replies is muted.
    expect(lex.getLexicon(-500)).toHaveLength(1);
  });

  it('respects the limit', async () => {
    await freshDb();
    const lex = await import('../src/db/repos/lexicon.repo.js');
    lex.recordTerms(-500, [
      { term: 'катка', gloss: 'игра' },
      { term: 'изи', gloss: 'легко' },
    ]);
    expect(lex.getVoiceLexicon(-500, 1)).toHaveLength(1);
  });
});

describe('/slang on|off', () => {
  it('lets the admin switch slang off and back on for the current chat', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdSlang } = await import('../src/bot/commands/lexicon.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const off = ctxFor('off');
    await cmdSlang(off.ctx);
    expect(repo.isChatSlangEnabled(1)).toBe(false);
    expect(off.replies[0]).toContain('ВЫКЛючен');

    const on = ctxFor('вкл');
    await cmdSlang(on.ctx);
    expect(repo.isChatSlangEnabled(1)).toBe(true);
    expect(on.replies[0]).toContain('ВКЛючен');
  });

  it('lets the admin target another chat from the DM', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdSlang } = await import('../src/bot/commands/lexicon.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const off = ctxFor('-500 off');
    await cmdSlang(off.ctx);
    expect(repo.isChatSlangEnabled(-500)).toBe(false);
    expect(off.replies[0]).toContain('-500');
    expect(off.replies[0]).toContain('/slang -500 on');
  });

  it('refuses a non-admin — it changes how the bot talks to everyone', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdSlang } = await import('../src/bot/commands/lexicon.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, replies } = ctxFor('off', { fromId: 777 });
    await cmdSlang(ctx);
    expect(repo.isChatSlangEnabled(777)).toBe(true);
    expect(replies[0]).toContain('админ');
  });

  it('still lists the words (with the switch state) and still clears them', async () => {
    await freshDb();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const lex = await import('../src/db/repos/lexicon.repo.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    const { cmdSlang } = await import('../src/bot/commands/lexicon.js');
    lex.recordTerms(1, [{ term: 'катка', gloss: 'игра' }]);

    const list = ctxFor('');
    await cmdSlang(list.ctx);
    expect(list.replies.join('\n')).toContain('катка');
    expect(list.replies.join('\n')).toContain('Сленг в ответах: ВКЛ');

    repo.setChatSlangEnabled(1, false);
    const listOff = ctxFor('');
    await cmdSlang(listOff.ctx);
    expect(listOff.replies.join('\n')).toContain('Сленг в ответах: ВЫКЛ');

    const clear = ctxFor('clear');
    await cmdSlang(clear.ctx);
    expect(lex.getLexicon(1)).toHaveLength(0);
  });
});
