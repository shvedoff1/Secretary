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
 * The chat's PERSONALITY PRESET (kept as "mode" in storage/commands for
 * continuity). 'secretary' is the default chill surfer; 'assistant' is the calm
 * one — same full skill set with the persona taken OUT, steered by the chat's own
 * rules (see chat_rule); 'funny' is the jokester — full skill set, loud humour,
 * no surfer theme; 'custom' speaks whatever persona the admin described in plain
 * words (persona_prompt below; without one it behaves like the calm assistant);
 * 'tutor' is the strict accuracy-first study tutor (no humor/slang, reduced
 * tools); 'dota' is the full feature set voiced by a schoolkid Dota 2 "sensei"
 * plus the /ping roll call.
 *
 * Everything user-facing about a preset (names, labels, descriptions, the tone
 * defaults it applies to this chat's switches) lives in `src/modes.ts`; this type
 * is just the stored value.
 */
export type ChatMode = 'secretary' | 'assistant' | 'funny' | 'custom' | 'tutor' | 'dota';

const MODE_VALUES: readonly string[] = [
  'secretary',
  'assistant',
  'funny',
  'custom',
  'tutor',
  'dota',
];

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
 * The chat's CUSTOM personality description (the «custom» preset): the admin's
 * plain-words text that becomes a persona override on the system prompt. NULL =
 * not set — a custom-preset chat then behaves like the calm assistant. Managed
 * with /prompt <chatId> [<текст>|clear].
 */
export function getPersonaPrompt(chatId: number): string | null {
  const row = getDb()
    .prepare('SELECT persona_prompt FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { persona_prompt: string | null } | undefined;
  const text = row?.persona_prompt?.trim();
  return text ? text : null;
}

export function setPersonaPrompt(chatId: number, prompt: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, persona_prompt, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         persona_prompt = excluded.persona_prompt, updated_at = excluded.updated_at`,
    )
    .run(chatId, prompt);
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
 * Best-effort chat title, recorded from incoming updates (see bot.ts) so admin
 * lists can show a name instead of a bare id. chat_config.title covers only
 * Splid-linked chats; this covers every chat the bot hears from.
 */
export function getChatTitle(chatId: number): string | null {
  const row = getDb()
    .prepare('SELECT title FROM chat_settings WHERE chat_id = ?')
    .get(chatId) as { title: string | null } | undefined;
  return row?.title ?? null;
}

export function setChatTitle(chatId: number, title: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, title, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         title = excluded.title, updated_at = excluded.updated_at
       WHERE chat_settings.title IS NOT excluded.title`,
    )
    .run(chatId, title);
}

export interface KnownChatRow {
  chat_id: number;
  title: string | null;
  mode: string | null;
  trusted: number | null;
}

/** Every chat with a settings row (any chat someone configured or that has a title). */
export function listKnownChats(): KnownChatRow[] {
  return getDb()
    .prepare('SELECT chat_id, title, mode, trusted FROM chat_settings ORDER BY chat_id')
    .all() as KnownChatRow[];
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
