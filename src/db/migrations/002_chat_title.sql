-- Human-readable chat title, so the admin can tell chats apart in /chats.
ALTER TABLE chat_config ADD COLUMN title TEXT;
