-- Chat rules: standing behaviour instructions for a chat, in the user's own
-- words («все голосовые очищай от слов-паразитов и скидывай расшифровку»,
-- «отвечай короче», «не используй эмодзи»). Unlike memory (facts the bot KNOWS)
-- a rule is an instruction the bot FOLLOWS: it is injected into every turn's
-- context block as a standing directive, so it must stay a small, curated list —
-- hence the per-chat cap enforced in the repo (CHAT_RULES_MAX).
-- Written by the `set_rule` tool («с этого момента …») and by /rules add.
CREATE TABLE IF NOT EXISTS chat_rule (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  tg_user_id INTEGER,               -- who set it (null for unknown/scheduled)
  created_at INTEGER NOT NULL       -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_chat_rule_chat ON chat_rule (chat_id, id);
