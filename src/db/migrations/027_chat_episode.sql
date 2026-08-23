-- Episodic memory («журнал бесед»): one row per CLOSED conversation session.
--
-- The assistant's verbatim history window (conversation_turn) is deliberately tiny
-- and the raw log (chat_message_log) is deliberately huge — nothing in between told
-- the model WHAT was talked about earlier without paying for the whole transcript.
-- An episode is that middle tier: when a chat goes quiet (EPISODE_QUIET_MINUTES),
-- the finished session's log slice is compressed by a cheap model into a few lines
-- of notes plus topic tags, and stored here. The newest episodes are injected into
-- the context block as a "conversation journal", older ones are searched by
-- recall_memory, and summarize_chat can replay any episode's period verbatim.
--
-- MAX(ended_at) per chat is the close watermark: only log messages newer than it
-- are candidates for the next episode, so closing is idempotent across restarts
-- (no in-memory timers — boundaries are re-derived from log timestamps).
CREATE TABLE IF NOT EXISTS chat_episode (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,            -- unix ms of the session's first message
  ended_at      INTEGER NOT NULL,            -- unix ms of the session's last message
  message_count INTEGER NOT NULL,
  summary       TEXT    NOT NULL,            -- cheap-model NOTES (facts kept, wording dropped) — never verbatim
  topics        TEXT    NOT NULL DEFAULT '', -- comma-joined lowercase tags, searchable
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_episode_chat_ended
  ON chat_episode (chat_id, ended_at);
