-- Per-chat assistant mode. 'secretary' (default) is the usual chill assistant;
-- 'tutor' turns the chat into a strict, accuracy-first study tutor (exam prep):
-- no humor/slang/surf, precise step-by-step answers. NULL means 'secretary'.
ALTER TABLE chat_settings ADD COLUMN mode TEXT;
