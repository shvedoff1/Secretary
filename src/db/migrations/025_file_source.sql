-- Attached FILES («док»: a PDF, a text file, an uncompressed image) are now a
-- channel of their own, alongside text / voice / photo. Two CHECK constraints
-- spell the channel list out, and SQLite can't widen a CHECK in place — so both
-- tables are recreated with 'file' allowed and their rows copied over (same
-- procedure as migration 007, which added 'voice').
--
-- Without this, the first PDF receipt someone confirms would fail its INSERT on
-- the pending_expense constraint, and every logged file message would fail on
-- chat_message_log.

-- Guard: a DB whose history starts after 001 (the synthetic bases the migration
-- tests build) may not have this table at all. Creating it in its pre-025 shape
-- first is a no-op on every real DB and makes the rebuild below unconditional.
CREATE TABLE IF NOT EXISTS pending_expense (
  id         TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  draft_json TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('text', 'photo', 'voice')),
  status     TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'confirmed', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL
);

ALTER TABLE pending_expense RENAME TO pending_expense_old;

CREATE TABLE pending_expense (
  id         TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  draft_json TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('text', 'photo', 'voice', 'file')),
  status     TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'confirmed', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL
);

INSERT INTO pending_expense (id, chat_id, tg_user_id, draft_json, source, status, created_at)
SELECT id, chat_id, tg_user_id, draft_json, source, status, created_at FROM pending_expense_old;

DROP TABLE pending_expense_old;

CREATE TABLE IF NOT EXISTS chat_message_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER,
  sender_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user', 'assistant')),
  kind        TEXT NOT NULL DEFAULT 'text'   CHECK (kind IN ('text', 'voice', 'photo')),
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

ALTER TABLE chat_message_log RENAME TO chat_message_log_old;

CREATE TABLE chat_message_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER,
  sender_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user', 'assistant')),
  kind        TEXT NOT NULL DEFAULT 'text'   CHECK (kind IN ('text', 'voice', 'photo', 'file')),
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

INSERT INTO chat_message_log (id, chat_id, tg_user_id, sender_name, role, kind, content, created_at)
SELECT id, chat_id, tg_user_id, sender_name, role, kind, content, created_at FROM chat_message_log_old;

DROP TABLE chat_message_log_old;

-- The old table's index went with it.
CREATE INDEX IF NOT EXISTS idx_chat_log_chat_created
  ON chat_message_log (chat_id, created_at);
