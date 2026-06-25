-- Per-chat "daily spending report" feature: an opt-in morning digest of
-- yesterday's expenses (pulled from the provider), run through the humorizer.
-- Settings live in chat_settings (not chat_config) so a chat can toggle it
-- independently; the report itself still needs a linked provider group.
ALTER TABLE chat_settings ADD COLUMN daily_spending_enabled INTEGER NOT NULL DEFAULT 0;
-- Local wall-clock time (chat timezone) at which the digest for the previous day
-- is posted. Defaults to 09:00.
ALTER TABLE chat_settings ADD COLUMN daily_spending_hour INTEGER NOT NULL DEFAULT 9;
ALTER TABLE chat_settings ADD COLUMN daily_spending_minute INTEGER NOT NULL DEFAULT 0;
-- The report date (YYYY-MM-DD, chat-local) most recently posted. Guards against
-- double-posting within a day and lets the digest catch up if the bot was down
-- at the exact target minute.
ALTER TABLE chat_settings ADD COLUMN daily_spending_last_date TEXT;
