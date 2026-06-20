-- Users known to the bot and their authorization status.
CREATE TABLE IF NOT EXISTS users (
  tg_user_id   INTEGER PRIMARY KEY,
  username     TEXT,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'user'    CHECK (role IN ('admin', 'user')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('approved', 'pending', 'denied')),
  requested_at INTEGER,
  decided_at   INTEGER,
  decided_by   INTEGER
);

-- Per-chat provider configuration.
CREATE TABLE IF NOT EXISTS chat_config (
  chat_id           INTEGER PRIMARY KEY,
  provider_name     TEXT NOT NULL DEFAULT 'splid',
  credential        TEXT,            -- e.g. Splid invite code
  provider_group_id TEXT,            -- resolved + cached
  default_currency  TEXT NOT NULL,
  created_by        INTEGER,
  created_at        INTEGER NOT NULL
);

-- Maps a Telegram user to a provider member, scoped per chat.
CREATE TABLE IF NOT EXISTS member_map (
  chat_id            INTEGER NOT NULL,
  tg_user_id         INTEGER NOT NULL,
  provider_member_id TEXT NOT NULL,
  member_name        TEXT NOT NULL,
  PRIMARY KEY (chat_id, tg_user_id)
);

-- Pending (un-confirmed) expense previews. The id is embedded in callback_data.
CREATE TABLE IF NOT EXISTS pending_expense (
  id         TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  draft_json TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('text', 'photo')),
  status     TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'confirmed', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL
);

-- One row per submission attempt outcome.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  tg_user_id    INTEGER NOT NULL,
  pending_id    TEXT,
  provider_name TEXT NOT NULL,
  external_id   TEXT,
  draft_json    TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('submitted', 'failed')),
  error         TEXT,
  created_at    INTEGER NOT NULL
);

-- Free-form per-chat memory (markdown), editable by users and the bot.
CREATE TABLE IF NOT EXISTS chat_memory (
  chat_id    INTEGER PRIMARY KEY,
  content    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Recent conversation history per chat for the assistant context window.
CREATE TABLE IF NOT EXISTS conversation_turn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  tg_user_id INTEGER,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_chat_created
  ON conversation_turn (chat_id, created_at);
