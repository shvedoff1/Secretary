-- Full rolling log of what was actually SAID in a chat, so the bot can answer
-- «перескажи, что тут было» about messages it never replied to.
--
-- Why a new table: `conversation_turn` is the assistant's context window — it only
-- holds turns the bot took part in (an addressed ask + its own reply) and is pruned
-- to a couple of dozen rows. Group chatter the bot stayed out of was kept only in an
-- in-memory ring of 12 lines (`recentChat.ts`, lost on restart) and in
-- `chat_lexicon_sample`, whose rows are DELETED as soon as a learning batch claims
-- them. So «что было в последних 200 сообщениях» had nothing to read from.
--
-- This table is that missing raw record: every incoming message (text, voice
-- transcript, photo caption) plus the bot's own posts, with the author and time, kept
-- per chat and bounded by count + age (CHAT_LOG_KEEP_PER_CHAT / CHAT_LOG_RETENTION_DAYS).
-- Read back by the `summarize_chat` tool; storage costs no tokens, only the summary does.
CREATE TABLE IF NOT EXISTS chat_message_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER,                       -- NULL for the bot's own posts
  sender_name TEXT,                          -- display name of the author, NULL for the bot
  role        TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user', 'assistant')),
  kind        TEXT NOT NULL DEFAULT 'text'   CHECK (kind IN ('text', 'voice', 'photo')),
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_log_chat_created
  ON chat_message_log (chat_id, created_at);
