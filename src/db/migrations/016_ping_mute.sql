-- Per-member "quiet hours" for the /ping roll call: windows during which a
-- member must NOT be tagged («не тегай меня до 19:00 по будням»). One row per
-- window; a member can hold several. `member` is the normalized key (leading @
-- stripped, lower-cased) so «@Vasya» and «vasya» share rules. dow_mask has bit
-- (d-1) set for ISO weekday d (1=Mon … 7=Sun). Minutes are local to `timezone`
-- (default Europe/Moscow at the write site), end-exclusive; from > to wraps
-- past midnight.
CREATE TABLE IF NOT EXISTS ping_mute_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  member TEXT NOT NULL,
  dow_mask INTEGER NOT NULL,
  from_min INTEGER NOT NULL,
  to_min INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ping_mute_chat_member ON ping_mute_rule (chat_id, member);
