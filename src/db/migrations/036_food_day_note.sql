-- Calorie diary: a short free-text note per person per day («была тренировка»,
-- «день рождения», «болел»). Context for reading the numbers later — shown
-- under the day's table and listed under a period's per-day table. One row per
-- (chat, user, chat-local day); an empty note is a deleted row.
CREATE TABLE IF NOT EXISTS food_day_note (
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER NOT NULL,
  local_date  TEXT NOT NULL,               -- YYYY-MM-DD, chat-local
  text        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,            -- unix ms
  PRIMARY KEY (chat_id, tg_user_id, local_date)
);
