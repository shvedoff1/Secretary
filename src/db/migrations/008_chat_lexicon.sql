-- Per-chat learned "lexicon": the slang and deliberately distorted word-forms a
-- group actually uses (e.g. «тип» for «типа», «братик»). The bot passively buffers
-- incoming messages in chat_lexicon_sample; in batches a cheap model extracts the
-- characteristic words into chat_lexicon, which is then fed back into the assistant
-- context so it talks like the chat. Keyed by chat_id; works for DMs and groups.
CREATE TABLE IF NOT EXISTS chat_lexicon (
  chat_id    INTEGER NOT NULL,
  term       TEXT    NOT NULL,           -- the word/phrase as used (normalized lower-case)
  gloss      TEXT    NOT NULL DEFAULT '',-- short note: meaning / standard form it replaces
  frequency  INTEGER NOT NULL DEFAULT 1, -- how many extraction batches surfaced it
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, term)
);

-- Raw rolling buffer of recent messages awaiting the next extraction batch. Rows
-- are claimed (read + deleted in one transaction) when a batch fires, so the buffer
-- only ever holds messages not yet learned from.
CREATE TABLE IF NOT EXISTS chat_lexicon_sample (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lexicon_sample_chat
  ON chat_lexicon_sample (chat_id, created_at);
