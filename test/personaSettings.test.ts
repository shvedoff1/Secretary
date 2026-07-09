import { describe, it, expect, afterEach } from 'vitest';

/**
 * Persona selection persists per chat in chat_settings.persona_id (migration 013),
 * independently of the timezone column, and defaults to null (→ deployment default
 * → 'neutral'). Guard the migration + repo round-trip.
 */
let closeDb: (() => void) | undefined;

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const repo = await import('../src/db/repos/chatSettings.repo.js');
  ({ closeDb } = await import('../src/db/client.js'));
  return repo;
}

afterEach(() => {
  closeDb?.();
  closeDb = undefined;
});

describe('chat_settings persona', () => {
  it('defaults to null and round-trips a set value', async () => {
    const repo = await load();
    expect(repo.getPersonaId(42)).toBeNull();
    repo.setPersonaId(42, 'chill');
    expect(repo.getPersonaId(42)).toBe('chill');
  });

  it('does not clobber the timezone (independent columns)', async () => {
    const repo = await load();
    repo.setTimezone(42, 'Asia/Makassar');
    repo.setPersonaId(42, 'formal');
    expect(repo.getTimezone(42)).toBe('Asia/Makassar');
    expect(repo.getPersonaId(42)).toBe('formal');

    // ...and setting the timezone after a persona keeps the persona.
    repo.setTimezone(42, 'UTC');
    expect(repo.getPersonaId(42)).toBe('formal');
  });

  it('can clear the persona back to null', async () => {
    const repo = await load();
    repo.setPersonaId(7, 'chill');
    repo.setPersonaId(7, null);
    expect(repo.getPersonaId(7)).toBeNull();
  });
});
