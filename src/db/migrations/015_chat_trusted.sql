-- Admin-granted trust for a whole chat: participants of a trusted chat pass the
-- default-deny auth gate without a personal whitelist entry (same standing as a
-- Splid-connected group). Set when the admin picks a mode for a freshly-added
-- chat (the DM notification buttons) or via /mode; 0/NULL = not trusted.
ALTER TABLE chat_settings ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;
