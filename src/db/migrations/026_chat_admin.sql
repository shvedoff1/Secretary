-- Chat admins: per-chat management rights, so the bot can be run by more than
-- one person. Two tiers, deliberately flat (no nesting):
--   * supreme admins ("верховный админ") — users.role = 'admin'; manage EVERY
--     chat, the whitelist, and appoint/dismiss both chat admins and other
--     supreme admins (that's how rights are handed over). The configured
--     ADMIN_TELEGRAM_ID is always re-ensured as one on startup.
--   * chat admins — rows here; each row grants ONE user management of ONE chat
--     (all the per-chat admin commands: /chat, /mode, /rules, /humor, …).
-- A user may admin several chats and a chat may have several admins.
CREATE TABLE IF NOT EXISTS chat_admin (
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER NOT NULL,
  granted_by  INTEGER,             -- which supreme admin granted it
  granted_at  INTEGER NOT NULL,    -- unix ms
  PRIMARY KEY (chat_id, tg_user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_admin_user ON chat_admin (tg_user_id);

-- A human-readable chat title for ANY chat the bot knows (chat_config.title only
-- exists for Splid-linked chats). Recorded best-effort from incoming updates so
-- the admin's /chats list can show names instead of bare ids.
ALTER TABLE chat_settings ADD COLUMN title TEXT;
