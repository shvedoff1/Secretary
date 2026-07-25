-- Per-chat switch for the OpenAI humor passes (the tone-rewrite humorizer,
-- humour scheduled tasks, the spending-digest rewrite and the expense quip).
-- Global ENABLE_HUMOR / ENABLE_EXPENSE_QUIP still master-gate the features;
-- this lets the admin turn the jokes off COMPLETELY for a specific chat.
-- 0/NULL = humor allowed (default), 1 = disabled for this chat.
ALTER TABLE chat_settings ADD COLUMN humor_disabled INTEGER NOT NULL DEFAULT 0;
