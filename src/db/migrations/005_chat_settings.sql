-- Per-chat settings independent of the Splid provider config (which only exists
-- for chats linked to a group). Holds the chat's timezone so reminders only ask
-- for it once. Keyed by chat_id; works for DMs and groups alike.
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id    INTEGER PRIMARY KEY,
  timezone   TEXT,
  updated_at INTEGER NOT NULL
);
