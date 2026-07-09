-- Attribute each conversation turn to its author. Without a name on the row the
-- assistant saw a flat run of "user" messages and could not tell who said what —
-- so in a group it mixed people up (answered as if A said B's line, tagged the
-- wrong person). Storing the sender's display name lets the history be rendered as
-- "Name: message" so the model always knows who is speaking. NULL for assistant
-- turns (the bot) and for legacy rows written before this column existed.
ALTER TABLE conversation_turn ADD COLUMN sender_name TEXT;
