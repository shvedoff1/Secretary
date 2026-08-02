-- Page watches ("вотчеры"): poll a web page until an awaited event appears on it,
-- then post a notification to the chat and stop. Created by the watch_page tool
-- («следи за страницей и напиши, когда появятся сеансы»), managed with /watch,
-- polled by the background runner alongside scheduled tasks.
CREATE TABLE IF NOT EXISTS page_watch (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          INTEGER NOT NULL,
  tg_user_id       INTEGER,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL,
  condition        TEXT NOT NULL,           -- awaited event, in plain words (fed to the checking model)
  keywords         TEXT NOT NULL,           -- JSON array of lowercase substrings that gate the LLM check
  interval_minutes INTEGER NOT NULL,        -- how often to poll
  expires_at       INTEGER NOT NULL,        -- unix ms; auto-disarm (with a note to the chat) past this
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_check_at    INTEGER NOT NULL,        -- unix ms of the next poll
  last_checked_at  INTEGER,
  last_hash        TEXT,                    -- hash of the last LLM-evaluated excerpt (skip re-asking on unchanged pages)
  fail_count       INTEGER NOT NULL DEFAULT 0, -- consecutive fetch failures
  fired_at         INTEGER,                 -- unix ms when the event was detected (watch disarmed)
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_watch_due
  ON page_watch (enabled, next_check_at);
