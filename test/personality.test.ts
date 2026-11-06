import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// The personality-preset refactor: presets write the chat's tone switches, the
// «custom» preset carries an admin-written persona prompt, and the setup card
// walks the admin through what each knob does.

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

describe('persona_prompt storage', () => {
  it('round-trips, trims to null, and is per chat', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    expect(repo.getPersonaPrompt(1)).toBeNull();
    repo.setPersonaPrompt(1, 'ты дворецкий-аристократ');
    expect(repo.getPersonaPrompt(1)).toBe('ты дворецкий-аристократ');
    expect(repo.getPersonaPrompt(2)).toBeNull();
    repo.setPersonaPrompt(1, null);
    expect(repo.getPersonaPrompt(1)).toBeNull();
  });

  it('does not clobber the other chat settings', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(1, 'custom');
    repo.setTimezone(1, 'Europe/Moscow');
    repo.setPersonaPrompt(1, 'персона');
    expect(repo.getChatMode(1)).toBe('custom');
    expect(repo.getTimezone(1)).toBe('Europe/Moscow');
  });

  it('round-trips the new funny and custom modes', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(1, 'funny');
    expect(repo.getChatMode(1)).toBe('funny');
    repo.setChatMode(1, 'custom');
    expect(repo.getChatMode(1)).toBe('custom');
  });
});

describe('applyModeDefaults', () => {
  it('writes the preset stances into the per-chat switches', async () => {
    await freshDb();
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    const { applyModeDefaults, modeSpec } = await import('../src/modes.js');

    applyModeDefaults(5, modeSpec('assistant'));
    expect(repo.isChatHumorEnabled(5)).toBe(false);
    expect(repo.isChimeEnabled(5)).toBe(false);
    expect(repo.isReactionsEnabled(5)).toBe(false);
    expect(repo.isChatSlangEnabled(5)).toBe(true);

    // Switching to a playful preset re-opens everything.
    applyModeDefaults(5, modeSpec('funny'));
    expect(repo.isChatHumorEnabled(5)).toBe(true);
    expect(repo.isChimeEnabled(5)).toBe(true);
    expect(repo.isReactionsEnabled(5)).toBe(true);
  });
});

describe('migration 029 backfill', () => {
  it('carries the old mode gates over into the switches for existing chats', async () => {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();

    const { getDb } = await import('../src/db/client.js');
    const db = getDb();
    // Synthetic pre-029 state: chat_settings as it stands before the personality
    // migration (its shape is untouched by 027/028), recorded at version 28. Tables
    // that LATER migrations alter have to exist too — a real v28 database has them
    // all, and migrate() runs every pending file, not just 029.
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version (version) VALUES (28)').run();
    db.exec(
      `CREATE TABLE chat_memory_sample (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         chat_id     INTEGER NOT NULL,
         tg_user_id  INTEGER NOT NULL,
         sender_name TEXT    NOT NULL,
         content     TEXT    NOT NULL,
         created_at  INTEGER NOT NULL
       )`,
    );
    db.exec(
      `CREATE TABLE chat_settings (
         chat_id            INTEGER PRIMARY KEY,
         timezone           TEXT,
         updated_at         INTEGER NOT NULL,
         mode               TEXT,
         trusted            INTEGER NOT NULL DEFAULT 0,
         chime_disabled     INTEGER NOT NULL DEFAULT 0,
         humor_disabled     INTEGER NOT NULL DEFAULT 0,
         reactions_disabled INTEGER NOT NULL DEFAULT 0,
         slang_disabled     INTEGER NOT NULL DEFAULT 0,
         title              TEXT
       )`,
    );
    const ins = db.prepare(
      'INSERT INTO chat_settings (chat_id, mode, updated_at) VALUES (?, ?, 1)',
    );
    ins.run(1, 'assistant');
    ins.run(2, 'tutor');
    ins.run(3, 'secretary');
    ins.run(4, null);

    const { migrate } = await import('../src/db/migrate.js');
    migrate(); // applies 029 onwards

    const repo = await import('../src/db/repos/chatSettings.repo.js');
    // The calm chat keeps its old behaviour: no jokes/chime/reactions, slang on.
    expect(repo.isChatHumorEnabled(1)).toBe(false);
    expect(repo.isChimeEnabled(1)).toBe(false);
    expect(repo.isReactionsEnabled(1)).toBe(false);
    expect(repo.isChatSlangEnabled(1)).toBe(true);
    // The tutor chat is fully off (and stays locked structurally anyway).
    expect(repo.isChatHumorEnabled(2)).toBe(false);
    expect(repo.isChatSlangEnabled(2)).toBe(false);
    // Playful/unset chats are untouched.
    expect(repo.isChatHumorEnabled(3)).toBe(true);
    expect(repo.isChimeEnabled(4)).toBe(true);
    // And the persona_prompt column arrived.
    expect(repo.getPersonaPrompt(1)).toBeNull();
  });
});

describe('system prompt selection', () => {
  it('maps every preset to its prompt, custom falling back to calm without a description', async () => {
    const p = await import('../src/llm/prompts.js');
    expect(p.systemPromptFor('secretary')).toBe(p.SYSTEM_PROMPT);
    expect(p.systemPromptFor('tutor')).toBe(p.TUTOR_SYSTEM_PROMPT);
    expect(p.systemPromptFor('dota')).toBe(p.DOTA_SYSTEM_PROMPT);
    expect(p.systemPromptFor('assistant')).toBe(p.ASSISTANT_SYSTEM_PROMPT);
    expect(p.systemPromptFor('funny')).toBe(p.FUNNY_SYSTEM_PROMPT);
    expect(p.systemPromptFor('custom', null)).toBe(p.ASSISTANT_SYSTEM_PROMPT);
    expect(p.systemPromptFor('custom', 'ты пират')).toBe(p.buildCustomSystemPrompt('ты пират'));
  });

  it('builds the funny prompt as a static persona suffix on the shared base', async () => {
    const p = await import('../src/llm/prompts.js');
    expect(p.FUNNY_SYSTEM_PROMPT.startsWith(p.SYSTEM_PROMPT)).toBe(true);
    expect(p.FUNNY_SYSTEM_PROMPT).toContain('ВЕСЕЛЬЧАК');
    // The surfer theme is explicitly banned in the funny persona.
    expect(p.FUNNY_SYSTEM_PROMPT).toContain('НЕ используешь');
  });

  it('frames the custom persona as a tone-only override on top of the base rules', async () => {
    const p = await import('../src/llm/prompts.js');
    const built = p.buildCustomSystemPrompt('ты дворецкий-аристократ, вежлив до занудства');
    expect(built.startsWith(p.SYSTEM_PROMPT)).toBe(true);
    expect(built).toContain('ты дворецкий-аристократ, вежлив до занудства');
    // The framing that keeps an admin description from overriding behaviour rules.
    expect(built).toContain('персона меняет тон, не факты и не правила');
  });
});

describe('humor persona per preset', () => {
  it('maps presets to tone-pass personas, custom carrying the admin description', async () => {
    const { humorPersonaForMode } = await import('../src/llm/humorize.js');
    expect(humorPersonaForMode('secretary')).toBe('surfer');
    expect(humorPersonaForMode('assistant')).toBe('surfer');
    expect(humorPersonaForMode('dota')).toBe('dota');
    expect(humorPersonaForMode('funny')).toBe('funny');
    expect(humorPersonaForMode('custom', 'ты пират')).toEqual({ custom: 'ты пират' });
    expect(humorPersonaForMode('custom', null)).toBe('surfer');
  });

  it('gives the custom persona its own rewrite prompt with the hard fact rules intact', async () => {
    const { buildHumorSystemPrompt } = await import('../src/llm/humorize.js');
    const prompt = buildHumorSystemPrompt([], { custom: 'ты пират, говоришь «арр»' });
    expect(prompt).toContain('ты пират, говоришь «арр»');
    expect(prompt).toContain('Every FACT stays EXACTLY');
    // The funny persona prompt exists and stays fact-locked too.
    const funny = buildHumorSystemPrompt([], 'funny');
    expect(funny).toContain('JOKESTER');
    expect(funny).toContain('Every FACT stays EXACTLY');
  });

  it('still appends the chat lexicon under any persona', async () => {
    const { buildHumorSystemPrompt } = await import('../src/llm/humorize.js');
    const prompt = buildHumorSystemPrompt([{ term: 'багос', gloss: 'баг' }], { custom: 'ты пират' });
    expect(prompt).toContain('багос');
  });
});

// --- the admin flow: /prompt, /setup ----------------------------------------

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

async function freshAdminDb() {
  await freshDb();
  const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
  ensureAdmin(1);
}

describe('/prompt', () => {
  it('stores the persona, switches the chat to the custom preset and trusts it', async () => {
    await freshAdminDb();
    const { cmdPrompt } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, replies } = adminCtx('-100500 ты дворецкий-аристократ');
    await cmdPrompt(ctx);

    expect(repo.getPersonaPrompt(-100500)).toBe('ты дворецкий-аристократ');
    expect(repo.getChatMode(-100500)).toBe('custom');
    expect(repo.isChatTrusted(-100500)).toBe(true);
    // The custom preset's defaults were applied (neutral canvas: humor off, slang on).
    expect(repo.isChatHumorEnabled(-100500)).toBe(false);
    expect(repo.isChatSlangEnabled(-100500)).toBe(true);
    expect(replies[0]!.text).toContain('кастом');
    // The setup card follows so the admin sees the knobs.
    expect(replies.map((r) => r.text).join('\n')).toContain('/humor -100500');
  });

  it('keeps the switches alone when the chat is already custom', async () => {
    await freshAdminDb();
    const { cmdPrompt } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(-1, 'custom');
    repo.setChatHumorEnabled(-1, true); // the admin turned jokes on earlier

    await cmdPrompt(adminCtx('-1 ты пират').ctx);

    expect(repo.getPersonaPrompt(-1)).toBe('ты пират');
    expect(repo.isChatHumorEnabled(-1)).toBe(true); // not reset by a re-описание
  });

  it('shows and clears the stored persona', async () => {
    await freshAdminDb();
    const { cmdPrompt } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(-1, 'custom');
    repo.setPersonaPrompt(-1, 'ты пират');

    const shown = adminCtx('-1');
    await cmdPrompt(shown.ctx);
    expect(shown.replies[0]!.text).toContain('ты пират');

    await cmdPrompt(adminCtx('-1 clear').ctx);
    expect(repo.getPersonaPrompt(-1)).toBeNull();
    // The preset stays custom — without a description it runs as the calm assistant.
    expect(repo.getChatMode(-1)).toBe('custom');
  });

  it('rejects an over-long persona instead of paying for it every turn', async () => {
    await freshAdminDb();
    const { cmdPrompt } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');

    const { ctx, replies } = adminCtx(`-1 ${'а'.repeat(2500)}`);
    await cmdPrompt(ctx);

    expect(replies[0]!.text).toContain('Слишком длинно');
    expect(repo.getPersonaPrompt(-1)).toBeNull();
  });

  it('is admin-only (DM)', async () => {
    await freshAdminDb();
    const { cmdPrompt } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    await cmdPrompt(adminCtx('-1 ты пират', 999).ctx);
    expect(repo.getPersonaPrompt(-1)).toBeNull();
  });
});

describe('/setup', () => {
  it('renders the behaviour card: every knob explained with its command and state', async () => {
    await freshAdminDb();
    const { cmdSetup } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(-100500, 'assistant');
    repo.setChatHumorEnabled(-100500, false);

    const { ctx, replies } = adminCtx('-100500');
    await cmdSetup(ctx);
    const card = replies.map((r) => r.text).join('\n');

    expect(card).toContain('Юморайзер');
    expect(card).toContain('Сленг');
    expect(card).toContain('Вбросы');
    expect(card).toContain('Реакции');
    expect(card).toContain('/humor -100500 on');
    expect(card).toContain('/slang -100500 on');
    expect(card).toContain('/chime -100500 on');
    expect(card).toContain('/react -100500 on');
    expect(card).toContain('/prompt -100500');
    expect(card).toContain('/rules -100500 add');
    // Current state is shown, not just the commands.
    expect(card).toContain('Юморайзер</b> — выкл');
  });

  it('flags the tutor lock on a tutor chat', async () => {
    await freshAdminDb();
    const { cmdSetup } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    repo.setChatMode(-2, 'tutor');

    const { ctx, replies } = adminCtx('-2');
    await cmdSetup(ctx);
    expect(replies.map((r) => r.text).join('\n')).toContain('репетитора');
  });
});
