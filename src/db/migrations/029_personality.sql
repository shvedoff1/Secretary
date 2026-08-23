-- Personality presets refactor (see src/modes.ts).
--
-- 1) The «custom» preset lets the admin describe the bot's character in their own
--    words; that text is appended to the system prompt as a persona override.
--    NULL = no custom persona set (a custom chat then behaves like the calm one).
ALTER TABLE chat_settings ADD COLUMN persona_prompt TEXT;

-- 2) The tone toggles (humor/slang/chime/reactions) used to be hard-gated by the
--    chat's mode ("assistant never jokes, whatever the /humor switch says"); now a
--    preset only WRITES these per-chat switches when it is picked, and afterwards
--    the switches alone decide (tutor stays structurally locked). Backfill chats
--    configured under the old semantics so a calm chat keeps behaving exactly the
--    same when the mode gate goes away. (The columns are NOT NULL DEFAULT 0, so
--    "switch on" can't be told apart from "never touched" — but under the old
--    semantics an explicit on was inert in these modes anyway, so disabling
--    preserves the observed behaviour in every case.)
UPDATE chat_settings SET humor_disabled = 1 WHERE mode IN ('assistant', 'tutor');
UPDATE chat_settings SET slang_disabled = 1 WHERE mode = 'tutor';
UPDATE chat_settings SET chime_disabled = 1 WHERE mode IN ('assistant', 'tutor');
UPDATE chat_settings SET reactions_disabled = 1 WHERE mode IN ('assistant', 'tutor');
