-- Per-chat "expense dictionary": extra trigger words/phrases that mark a message
-- as a likely expense, on top of the built-in EXPENSE_KEYWORDS regex in
-- src/bot/triggers.ts. This lets the bot LEARN new expense vocabulary at runtime
-- (no redeploy): when a message clearly reports a spend the bot missed, the user
-- replies «запомни, это трата» and the assistant extracts the distinctive
-- keyword(s) into here. looksLikeExpenseForChat() consults this table so future
-- messages containing the term (with a number) auto-route as expenses.
CREATE TABLE IF NOT EXISTS chat_expense_term (
  chat_id    INTEGER NOT NULL,
  term       TEXT    NOT NULL,  -- the trigger word/phrase (normalized lower-case)
  tg_user_id INTEGER,           -- who taught it (nullable)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, term)
);

CREATE INDEX IF NOT EXISTS idx_expense_term_chat ON chat_expense_term (chat_id);
