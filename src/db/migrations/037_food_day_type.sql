-- Calorie diary: DAY TYPES — a training day wants a different КБЖУ target than
-- a rest day. Each person defines their own named types («тренировка»,
-- «отдых»), each with its own daily goal; the plain food_goal stays the
-- default for a day with no type. A day's chosen type lives in food_day_kind;
-- the goal shown for a day is its type's goal, else the default.
CREATE TABLE IF NOT EXISTS food_day_type (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER NOT NULL,
  name        TEXT NOT NULL COLLATE NOCASE,
  kcal        REAL NOT NULL,
  protein     REAL,
  fat         REAL,
  carbs       REAL,
  created_at  INTEGER NOT NULL,
  UNIQUE (chat_id, tg_user_id, name)
);

-- Which type a day is. No row = the default goal. Deleting a type deletes the
-- days pointing at it (they fall back to the default) — done in the repo, since
-- SQLite foreign keys are not enabled here.
CREATE TABLE IF NOT EXISTS food_day_kind (
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER NOT NULL,
  local_date  TEXT NOT NULL,
  type_id     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, tg_user_id, local_date)
);
