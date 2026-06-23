-- Allow 'voice' as an expense source. SQLite can't alter a CHECK constraint in
-- place, so recreate the table with the widened constraint and copy rows over.
ALTER TABLE pending_expense RENAME TO pending_expense_old;

CREATE TABLE pending_expense (
  id         TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  draft_json TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('text', 'photo', 'voice')),
  status     TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'confirmed', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL
);

INSERT INTO pending_expense (id, chat_id, tg_user_id, draft_json, source, status, created_at)
SELECT id, chat_id, tg_user_id, draft_json, source, status, created_at FROM pending_expense_old;

DROP TABLE pending_expense_old;
