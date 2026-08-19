import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/chatSettings.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('chat mode setting', () => {
  it('defaults to secretary for a chat with no settings row', async () => {
    const repo = await freshRepo();
    expect(repo.getChatMode(1)).toBe('secretary');
  });

  it('round-trips tutor mode and back', async () => {
    const repo = await freshRepo();
    repo.setChatMode(1, 'tutor');
    expect(repo.getChatMode(1)).toBe('tutor');
    repo.setChatMode(1, 'secretary');
    expect(repo.getChatMode(1)).toBe('secretary');
  });

  it('does not clobber the chat timezone (both live in chat_settings)', async () => {
    const repo = await freshRepo();
    repo.setTimezone(1, 'Asia/Makassar');
    repo.setChatMode(1, 'tutor');
    expect(repo.getTimezone(1)).toBe('Asia/Makassar');
    // And the other way round: setting the timezone keeps the mode.
    repo.setTimezone(1, 'Europe/Moscow');
    expect(repo.getChatMode(1)).toBe('tutor');
  });

  it('round-trips dota mode and back', async () => {
    const repo = await freshRepo();
    repo.setChatMode(1, 'dota');
    expect(repo.getChatMode(1)).toBe('dota');
    repo.setChatMode(1, 'secretary');
    expect(repo.getChatMode(1)).toBe('secretary');
  });

  it('round-trips assistant mode and back', async () => {
    const repo = await freshRepo();
    repo.setChatMode(1, 'assistant');
    expect(repo.getChatMode(1)).toBe('assistant');
    repo.setChatMode(1, 'secretary');
    expect(repo.getChatMode(1)).toBe('secretary');
  });

  it('reads an unknown/legacy stored mode as the default instead of breaking the chat', async () => {
    const repo = await freshRepo();
    const { getDb } = await import('../src/db/client.js');
    getDb()
      .prepare(
        `INSERT INTO chat_settings (chat_id, mode, updated_at) VALUES (?, ?, unixepoch() * 1000)`,
      )
      .run(9, 'butler');
    expect(repo.getChatMode(9)).toBe('secretary');
  });

  it('is per chat', async () => {
    const repo = await freshRepo();
    repo.setChatMode(7, 'tutor');
    expect(repo.getChatMode(7)).toBe('tutor');
    expect(repo.getChatMode(8)).toBe('secretary');
  });
});

describe('per-chat humor setting', () => {
  it('defaults to enabled, round-trips, and is per chat', async () => {
    const repo = await freshRepo();
    expect(repo.isChatHumorEnabled(1)).toBe(true);
    repo.setChatHumorEnabled(1, false);
    expect(repo.isChatHumorEnabled(1)).toBe(false);
    expect(repo.isChatHumorEnabled(2)).toBe(true);
    repo.setChatHumorEnabled(1, true);
    expect(repo.isChatHumorEnabled(1)).toBe(true);
  });

  it('does not clobber the other chat settings', async () => {
    const repo = await freshRepo();
    repo.setChatMode(1, 'dota');
    repo.setChimeEnabled(1, false);
    repo.setChatHumorEnabled(1, false);
    expect(repo.getChatMode(1)).toBe('dota');
    expect(repo.isChimeEnabled(1)).toBe(false);
    expect(repo.isChatHumorEnabled(1)).toBe(false);
  });
});

describe('per-chat reactions setting', () => {
  it('defaults to enabled, round-trips, and is per chat', async () => {
    const repo = await freshRepo();
    expect(repo.isReactionsEnabled(1)).toBe(true);
    repo.setReactionsEnabled(1, false);
    expect(repo.isReactionsEnabled(1)).toBe(false);
    expect(repo.isReactionsEnabled(2)).toBe(true);
    repo.setReactionsEnabled(1, true);
    expect(repo.isReactionsEnabled(1)).toBe(true);
  });
});

describe('per-chat chime setting', () => {
  it('defaults to enabled, round-trips, and is per chat', async () => {
    const repo = await freshRepo();
    expect(repo.isChimeEnabled(1)).toBe(true);
    repo.setChimeEnabled(1, false);
    expect(repo.isChimeEnabled(1)).toBe(false);
    expect(repo.isChimeEnabled(2)).toBe(true); // other chats untouched
    repo.setChimeEnabled(1, true);
    expect(repo.isChimeEnabled(1)).toBe(true);
  });

  it('does not clobber mode/trust/timezone (all live in chat_settings)', async () => {
    const repo = await freshRepo();
    repo.setChatMode(1, 'dota');
    repo.setChatTrusted(1, true);
    repo.setTimezone(1, 'Europe/Moscow');
    repo.setChimeEnabled(1, false);
    expect(repo.getChatMode(1)).toBe('dota');
    expect(repo.isChatTrusted(1)).toBe(true);
    expect(repo.getTimezone(1)).toBe('Europe/Moscow');
  });
});
