-- Chat-specific learned name aliases (e.g. a nickname not in the built-in
-- Russian diminutive dictionary). Filled when a clarification resolves a
-- previously-unrecognised name.
CREATE TABLE IF NOT EXISTS name_alias (
  chat_id     INTEGER NOT NULL,
  alias       TEXT    NOT NULL,        -- normalized
  member_id   TEXT    NOT NULL,
  member_name TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (chat_id, alias)
);
