import { getDb } from '../client.js';

/** The chat's IANA timezone, or null if not set yet. */
export function getTimezone(chatId: number): string | null {
  const row = getDb()
    .prepare('SELECT timezone FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { timezone: string | null } | undefined;
  return row?.timezone ?? null;
}

export function setTimezone(chatId: number, timezone: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, timezone, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         timezone = excluded.timezone, updated_at = excluded.updated_at`,
    )
    .run(chatId, timezone);
}

/**
 * How the assistant behaves in this chat. 'secretary' is the default chill
 * surfer assistant; 'assistant' is the same full skill set with the persona taken
 * OUT — calm, neutral, no jokes/chime/reactions, steered by the chat's own rules
 * (see chat_rule); 'tutor' is the strict accuracy-first study tutor (no
 * humor/slang, no expense/surf skills — just precise dialogue and problem
 * solving); 'dota' is the full secretary feature set (memory, humor, slang,
 * chime) with a different persona — a schoolkid who fancies himself a Dota 2
 * teacher — plus the /dota ping-list roll call.
 *
 * Everything user-facing about a mode (labels, descriptions, which personality
 * features it allows) lives in `src/modes.ts`; this type is just the stored value.
 */
export type ChatMode = 'secretary' | 'assistant' | 'tutor' | 'dota';

const MODE_VALUES: readonly string[] = ['secretary', 'assistant', 'tutor', 'dota'];

export function getChatMode(chatId: number): ChatMode {
  const row = getDb()
    .prepare('SELECT mode FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { mode: string | null } | undefined;
  // Unknown/legacy values read as the default rather than breaking the chat.
  return row?.mode && MODE_VALUES.includes(row.mode) ? (row.mode as ChatMode) : 'secretary';
}

export function setChatMode(chatId: number, mode: ChatMode): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, mode, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         mode = excluded.mode, updated_at = excluded.updated_at`,
    )
    .run(chatId, mode);
}

/**
 * Per-chat switch for the spontaneous chime-in. Default is ON (a missing row or
 * a 0 flag both mean "allowed"); the global ENABLE_CHIME env flag still
 * master-gates the feature. Toggled by the admin with /chime <chatId> on|off.
 */
export function isChimeEnabled(chatId: number): boolean {
  const row = getDb()
    .prepare('SELECT chime_disabled FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { chime_disabled: number | null } | undefined;
  return !row?.chime_disabled;
}

export function setChimeEnabled(chatId: number, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, chime_disabled, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         chime_disabled = excluded.chime_disabled, updated_at = excluded.updated_at`,
    )
    .run(chatId, enabled ? 0 : 1);
}

/**
 * Per-chat switch for the random auto-reactions (the ~10% positive-emoji
 * seasoning). Default is ON. Toggled by the admin with /react <chatId> on|off.
 */
export function isReactionsEnabled(chatId: number): boolean {
  const row = getDb()
    .prepare('SELECT reactions_disabled FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { reactions_disabled: number | null } | undefined;
  return !row?.reactions_disabled;
}

export function setReactionsEnabled(chatId: number, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, reactions_disabled, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         reactions_disabled = excluded.reactions_disabled, updated_at = excluded.updated_at`,
    )
    .run(chatId, enabled ? 0 : 1);
}

/**
 * Per-chat switch for the OpenAI humor passes (tone-rewrite humorizer, humour
 * tasks, spending-digest rewrite, expense quip). Default is ON; the global
 * ENABLE_HUMOR / ENABLE_EXPENSE_QUIP env flags still master-gate everything.
 * Toggled by the admin with /humor <chatId> on|off.
 */
export function isChatHumorEnabled(chatId: number): boolean {
  const row = getDb()
    .prepare('SELECT humor_disabled FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { humor_disabled: number | null } | undefined;
  return !row?.humor_disabled;
}

export function setChatHumorEnabled(chatId: number, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, humor_disabled, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         humor_disabled = excluded.humor_disabled, updated_at = excluded.updated_at`,
    )
    .run(chatId, enabled ? 0 : 1);
}

/**
 * Per-chat switch for APPLYING the learned slang to replies — both as the
 * humorizer's lexicon and as the standalone slang pass over answers the
 * humorizer skips. Default is ON; the global ENABLE_SLANG / ENABLE_HUMOR env
 * flags still master-gate their respective passes, and lexicon LEARNING is
 * unaffected (that's ENABLE_LEXICON). Toggled with `/slang [<chatId>] on|off`.
 */
export function isChatSlangEnabled(chatId: number): boolean {
  const row = getDb()
    .prepare('SELECT slang_disabled FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { slang_disabled: number | null } | undefined;
  return !row?.slang_disabled;
}

export function setChatSlangEnabled(chatId: number, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, slang_disabled, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         slang_disabled = excluded.slang_disabled, updated_at = excluded.updated_at`,
    )
    .run(chatId, enabled ? 0 : 1);
}

/**
 * Admin-granted trust for a whole chat: participants of a trusted chat pass the
 * default-deny auth gate without personal whitelist entries — the same standing
 * a Splid-connected group gets. Granted when the admin explicitly configures the
 * chat (picks a mode from the "bot was added" DM, or runs /mode); revocable.
 */
export function isChatTrusted(chatId: number): boolean {
  const row = getDb()
    .prepare('SELECT trusted FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { trusted: number | null } | undefined;
  return !!row?.trusted;
}

export function setChatTrusted(chatId: number, trusted: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, trusted, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         trusted = excluded.trusted, updated_at = excluded.updated_at`,
    )
    .run(chatId, trusted ? 1 : 0);
}
