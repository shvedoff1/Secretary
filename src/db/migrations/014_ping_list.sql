-- Named ping lists (the dota-mode roll call): /dota pings the default list,
-- /dota <название> a named one; a chat can keep many lists. One row per member
-- per list; members are display tokens (@username pings, plain text just shows).
-- COLLATE NOCASE keeps "@Vasya" and "@vasya" from coexisting in one list.
CREATE TABLE IF NOT EXISTS ping_list_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  list_name TEXT NOT NULL COLLATE NOCASE,
  member TEXT NOT NULL COLLATE NOCASE,
  added_by INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (chat_id, list_name, member)
);

CREATE INDEX IF NOT EXISTS idx_ping_list_chat ON ping_list_entry (chat_id, list_name);
