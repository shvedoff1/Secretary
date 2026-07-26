-- Per-chat switch for the random auto-reactions (the ~10% chance a message
-- gets a positive emoji reaction). Lets the admin turn them off COMPLETELY for
-- a specific chat. 0/NULL = reactions allowed (default), 1 = disabled.
ALTER TABLE chat_settings ADD COLUMN reactions_disabled INTEGER NOT NULL DEFAULT 0;
