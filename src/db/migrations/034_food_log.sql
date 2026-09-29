-- Calorie diary («дневник еды»): what a person ATE, logged in plain words, by
-- voice or by a photo of the plate — no food-database search UI. The model
-- estimates calories/БЖУ per item (asking at most one clarifying question) and the
-- `log_food` tool writes one row per item. Figures are ESTIMATES by construction;
-- totals and statistics are computed deterministically from these rows.
--
-- Personal, not chat-wide: keyed by (chat_id, tg_user_id) so a group where two
-- people count calories keeps two diaries. `local_date` is the chat-local calendar
-- day the item belongs to, fixed at insert — a later timezone change must not
-- reshuffle yesterday's dinner into today.
CREATE TABLE IF NOT EXISTS food_entry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER NOT NULL,
  local_date  TEXT NOT NULL,               -- YYYY-MM-DD, chat-local
  meal        TEXT,                        -- breakfast|lunch|dinner|snack|null
  name        TEXT NOT NULL,
  grams       REAL,                        -- portion estimate, null when unknown
  kcal        REAL NOT NULL,
  protein     REAL,                        -- grams, null = not estimated
  fat         REAL,
  carbs       REAL,
  created_at  INTEGER NOT NULL             -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_food_entry_user_day
  ON food_entry (chat_id, tg_user_id, local_date);

-- Daily targets per person. Only kcal is required; macros are optional.
CREATE TABLE IF NOT EXISTS food_goal (
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER NOT NULL,
  kcal        REAL NOT NULL,
  protein     REAL,
  fat         REAL,
  carbs       REAL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, tg_user_id)
);
