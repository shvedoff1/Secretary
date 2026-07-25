-- Per-chat switch for the spontaneous chime-in (the random revive message the
-- bot drops into a lull). Global ENABLE_CHIME still master-gates the feature;
-- this lets the admin turn it off COMPLETELY for a specific chat.
-- 0/NULL = chime allowed (default), 1 = disabled for this chat.
ALTER TABLE chat_settings ADD COLUMN chime_disabled INTEGER NOT NULL DEFAULT 0;
