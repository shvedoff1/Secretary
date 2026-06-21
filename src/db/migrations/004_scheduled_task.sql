-- User-defined reminders and recurring tasks. A task runs its `prompt` through
-- the assistant on a cron schedule and posts the result back to the chat.
CREATE TABLE IF NOT EXISTS scheduled_task (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,           -- what the assistant should do when it fires
  cron        TEXT NOT NULL,           -- standard 5-field cron expression
  timezone    TEXT NOT NULL,           -- IANA timezone for the cron schedule
  once        INTEGER NOT NULL DEFAULT 0,  -- 1 => disable after first run
  enabled     INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,        -- unix ms of the next scheduled run
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_due
  ON scheduled_task (enabled, next_run_at);
