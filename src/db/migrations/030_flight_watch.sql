-- Flight watches («следи за рейсом»): poll a flight's live status until it is
-- cancelled / rescheduled / departs / lands, notify the chat on each change,
-- and disarm once the flight is over (or the watch expires). Created by the
-- watch_flight tool («напиши, если рейс K6829 отменят»), managed with /flight,
-- polled by the background runner alongside page watches.
CREATE TABLE IF NOT EXISTS flight_watch (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          INTEGER NOT NULL,
  tg_user_id       INTEGER,
  title            TEXT NOT NULL,
  flight           TEXT NOT NULL,           -- normalized IATA flight number, e.g. K6829
  flight_date      TEXT,                    -- YYYY-MM-DD asked about; NULL = nearest leg
  interval_minutes INTEGER NOT NULL,        -- how often to poll the feed
  expires_at       INTEGER NOT NULL,        -- unix ms; auto-disarm (with a note) past this
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_check_at    INTEGER NOT NULL,        -- unix ms of the next poll
  last_checked_at  INTEGER,
  last_snapshot    TEXT,                    -- JSON FlightSnapshot baseline (advanced only when the chat was notified)
  fail_count       INTEGER NOT NULL DEFAULT 0, -- consecutive feed failures
  fired_at         INTEGER,                 -- unix ms of the terminal event (watch disarmed)
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flight_watch_due
  ON flight_watch (enabled, next_check_at);
