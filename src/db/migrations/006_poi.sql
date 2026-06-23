-- Per-chat points of interest: cafes worth keeping, sights, plans. Rendered as a
-- grouped list with Google Maps links (by coordinates when known, else a text search).
CREATE TABLE IF NOT EXISTS point_of_interest (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  tg_user_id  INTEGER,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'place',
  description TEXT,
  address     TEXT,
  latitude    REAL,
  longitude   REAL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_poi_chat
  ON point_of_interest (chat_id, created_at);
