-- Dota 2 knowledge base: heroes, items and per-patch change notes, pulled nightly
-- from Valve's datafeed (see src/dota/) and rendered into ready text cards. The
-- `dota_lookup` tool reads this table so the assistant answers with the CURRENT
-- patch instead of stale training data.
--
-- Unlike everything else in this schema the data is GLOBAL, not per chat: it is
-- reference data about the game, identical for every chat.
CREATE TABLE IF NOT EXISTS dota_entity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,              -- 'hero' | 'item' | 'patch'
  key        TEXT NOT NULL,              -- internal name: npc_dota_hero_juggernaut / item_blink / patch:<subject>
  feed_id    INTEGER,                    -- id in the datafeed (null for patch notes)
  name       TEXT NOT NULL,              -- display name, English (Valve does not localise names)
  card       TEXT NOT NULL,              -- full rendered card handed to the model
  summary    TEXT NOT NULL,              -- short digest, used when several entities are asked at once
  search     TEXT NOT NULL,              -- flattened text backing the FTS index
  patch      TEXT NOT NULL,              -- patch the data was pulled on, e.g. '7.41e'
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_dota_entity_kind ON dota_entity (kind);

-- Lookup keys for an entity: the normalised display name, the internal key and
-- the key without its npc_dota_hero_/item_ prefix. Kept as a table (rather than
-- normalising in SQL at query time) so an exact name hit is a single index read.
CREATE TABLE IF NOT EXISTS dota_alias (
  alias     TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (alias, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_dota_alias ON dota_alias (alias);

-- Freetext search over the same rows ("какие предметы дают спелл-вампиризм") and
-- the fallback when an exact name lookup misses. Kept as a plain (not external
-- content) table and rebuilt wholesale inside the sync transaction, so it can
-- never drift from dota_entity.
CREATE VIRTUAL TABLE IF NOT EXISTS dota_fts USING fts5(
  name,
  body,
  entity_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Single-row sync bookkeeping: which patch the KB holds and when it was last
-- rebuilt, so the nightly job can skip the ~550-request crawl when nothing moved.
CREATE TABLE IF NOT EXISTS dota_sync_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  patch          TEXT,
  last_full_sync INTEGER,
  last_check     INTEGER,
  last_error     TEXT
);
