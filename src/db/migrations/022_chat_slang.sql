-- Per-chat switch for APPLYING the learned slang to the bot's replies (the
-- learning itself is the global ENABLE_LEXICON flag). Until now slang could
-- only reach a reply as a passenger of the OpenAI humorizer, so `/humor off`
-- silently killed it too; this column makes it an independent knob, toggled by
-- the admin with `/slang [<chatId>] on|off`.
-- 0/NULL = slang applied (default), 1 = the chat's replies stay slang-free.
ALTER TABLE chat_settings ADD COLUMN slang_disabled INTEGER NOT NULL DEFAULT 0;
