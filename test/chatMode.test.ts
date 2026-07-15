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

  it('is per chat', async () => {
    const repo = await freshRepo();
    repo.setChatMode(7, 'tutor');
    expect(repo.getChatMode(7)).toBe('tutor');
    expect(repo.getChatMode(8)).toBe('secretary');
  });
});
