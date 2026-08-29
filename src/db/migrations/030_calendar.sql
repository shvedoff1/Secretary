-- Google Calendar connection («календарь»): a chat links one or more calendars by
-- their SECRET iCal (ICS) URL — Google Calendar's «Секретный адрес в формате iCal»
-- needs no OAuth and is read-only by construction. A background poller fetches the
-- feed, expands recurring events, and caches a horizon window of occurrences here;
-- the reminder planner turns them into evening/morning digests and «скоро …»
-- pre-event pings.
--
-- SECURITY: every table carries chat_id and every read is chat-scoped — a
-- calendar's events can only ever surface in the chat it was connected to. The
-- ics_url is a secret: it is never echoed back in full (commands show a mask).
CREATE TABLE IF NOT EXISTS chat_calendar (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        INTEGER NOT NULL,
  tg_user_id     INTEGER,                    -- who connected it
  name           TEXT NOT NULL,              -- display label («личный», «работа»)
  ics_url        TEXT NOT NULL,              -- SECRET private ICS address
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_fetch_at  INTEGER NOT NULL DEFAULT 0, -- unix ms of the next poll (0 = ASAP)
  last_fetch_at  INTEGER,                    -- unix ms of the last attempt
  last_ok_at     INTEGER,                    -- unix ms of the last successful fetch
  fail_count     INTEGER NOT NULL DEFAULT 0, -- consecutive fetch failures
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_calendar_due
  ON chat_calendar (enabled, next_fetch_at);
CREATE INDEX IF NOT EXISTS idx_chat_calendar_chat
  ON chat_calendar (chat_id);

-- Cached event occurrences (recurrences already expanded), replaced wholesale on
-- each successful fetch. chat_id is denormalised on purpose: every read path is
-- chat-scoped, so the scoping cannot be forgotten in a join.
CREATE TABLE IF NOT EXISTS calendar_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id  INTEGER NOT NULL,
  chat_id      INTEGER NOT NULL,
  uid          TEXT NOT NULL,               -- ICS UID of the source event
  title        TEXT NOT NULL,
  location     TEXT,
  description  TEXT,
  starts_at    INTEGER NOT NULL,            -- unix ms (all-day: UTC midnight of the date)
  ends_at      INTEGER,                     -- unix ms, null if unknown
  all_day      INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  UNIQUE (calendar_id, uid, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_calendar_event_chat_time
  ON calendar_event (chat_id, starts_at);

-- Which reminders already went out, so a restart never re-sends one. `slot` is a
-- deterministic key: 'evening:<YYYY-MM-DD>' / 'morning:<YYYY-MM-DD>' for digests
-- (the local date they cover), 'soon:<uid>:<startMs>' for pre-event pings.
CREATE TABLE IF NOT EXISTS calendar_notice (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id  INTEGER NOT NULL,
  slot     TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  UNIQUE (chat_id, slot)
);
