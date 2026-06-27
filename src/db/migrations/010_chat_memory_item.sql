-- Human-like weighted memory. Replaces the single free-text `chat_memory` blob
-- with discrete, weighted memory items so the assistant's recall behaves like a
-- person's: recent and important facts stand out, trivia fades, and knowledge is
-- split into facts about the GROUP vs. facts about an individual participant.
--
-- Effective weight is computed at read time from importance (salience the
-- extractor assigned), reinforcement (how often the fact recurs) and the age since
-- it was last seen (exponential time-decay). Explicitly remembered facts
-- (source='explicit', e.g. the `remember` tool / `/remember`) are pinned: they do
-- not decay and are exempt from pruning. Keyed by chat_id; works for DMs and groups.
CREATE TABLE IF NOT EXISTS chat_memory_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  scope       TEXT    NOT NULL,            -- 'chat' (shared) | 'user' (about a person)
  tg_user_id  INTEGER,                     -- NULL for chat-scope; set when known for user-scope
  subject     TEXT    NOT NULL DEFAULT '', -- denormalized display name for user-scope ('' for chat)
  content     TEXT    NOT NULL,            -- the fact, one short sentence
  importance  REAL    NOT NULL DEFAULT 1,  -- base salience 1..5 from the extractor
  reinforce   INTEGER NOT NULL DEFAULT 0,  -- times the fact was re-mentioned (decay reset on each)
  source      TEXT    NOT NULL DEFAULT 'passive', -- 'passive' (extracted) | 'explicit' (pinned)
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_item_chat ON chat_memory_item (chat_id, scope);
CREATE INDEX IF NOT EXISTS idx_memory_item_user ON chat_memory_item (chat_id, tg_user_id);

-- Rolling buffer of recent messages awaiting the next extraction batch. Unlike the
-- lexicon buffer this carries the SENDER (id + name) so the extractor can attribute
-- per-person facts. Rows are claimed (read + deleted in one transaction) on flush.
CREATE TABLE IF NOT EXISTS chat_memory_sample (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER NOT NULL,
  sender_name TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_sample_chat ON chat_memory_sample (chat_id, created_at);

-- Backfill: carry each existing chat_memory blob over as one pinned chat-scope
-- item, so nothing previously remembered is lost. Users can re-curate via /memory.
INSERT INTO chat_memory_item
  (chat_id, scope, tg_user_id, subject, content, importance, reinforce, source, created_at, last_seen)
SELECT chat_id, 'chat', NULL, '', content, 3, 0, 'explicit', updated_at, updated_at
FROM chat_memory
WHERE trim(content) <> '';
