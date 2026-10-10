-- Forum chats, media references and a listen-only switch — the «бот сидит в рабочем
-- чате с тредами, всё запоминает и потом делает саммари» setup.
--
-- 1. chat_message_log learns WHERE and WHAT a line was:
--    * thread_id  — the forum topic (message_thread_id) the message was posted in;
--                   NULL outside forums and in the General topic. Lets a recap be
--                   scoped to one thread («что было в треде QA»).
--    * message_id — the Telegram message id, so a recap / bug candidate can link
--                   back to the source message (t.me/c/… works in supergroups).
--    * media_file_id — for photos / videos / image files: the file_id of something
--                   CHEAP to look at later (the photo itself, a video's thumbnail).
--                   Nothing is downloaded at log time — media is kept as a reference
--                   and opened on demand by the `view_media` tool.
--    and the channel list gains 'video' (videos and video notes). SQLite can't widen
--    a CHECK in place, so the table is rebuilt (same procedure as 007 / 025).
-- 2. chat_topic — forum topic names, learned from the service messages Telegram
--    sends (topic created / renamed) and from the topic-root reference every
--    message in a topic carries.
-- 3. chat_settings.listen_only — a voice note is answered only when it is addressed
--    to the bot; otherwise it is transcribed and logged silently. Without it every
--    voice note in a busy work chat would get a reply.

-- Guard for synthetic bases that start after 024 (see 025).
CREATE TABLE IF NOT EXISTS chat_message_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER,
  sender_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user', 'assistant')),
  kind        TEXT NOT NULL DEFAULT 'text'   CHECK (kind IN ('text', 'voice', 'photo', 'file')),
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

ALTER TABLE chat_message_log RENAME TO chat_message_log_old;

CREATE TABLE chat_message_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  tg_user_id    INTEGER,
  sender_name   TEXT,
  role          TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user', 'assistant')),
  kind          TEXT NOT NULL DEFAULT 'text'   CHECK (kind IN ('text', 'voice', 'photo', 'file', 'video')),
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  thread_id     INTEGER,
  message_id    INTEGER,
  media_file_id TEXT
);

INSERT INTO chat_message_log (id, chat_id, tg_user_id, sender_name, role, kind, content, created_at)
SELECT id, chat_id, tg_user_id, sender_name, role, kind, content, created_at FROM chat_message_log_old;

DROP TABLE chat_message_log_old;

CREATE INDEX IF NOT EXISTS idx_chat_log_chat_created
  ON chat_message_log (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_log_chat_thread_created
  ON chat_message_log (chat_id, thread_id, created_at);

CREATE TABLE IF NOT EXISTS chat_topic (
  chat_id    INTEGER NOT NULL,
  thread_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, thread_id)
);

-- Guard (see above): synthetic bases may predate chat_settings.
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id    INTEGER PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
ALTER TABLE chat_settings ADD COLUMN listen_only INTEGER NOT NULL DEFAULT 0;
