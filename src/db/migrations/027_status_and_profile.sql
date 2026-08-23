-- Phase 3 of human-like memory: current STATE vs. durable traits, and a
-- maintained profile card per chat/person.
--
-- 1) `kind` on memory items. «Юзер сейчас во Вьетнаме» is not the same sort of
-- fact as «юзер серфит»: a STATUS is true NOW and should stop being served long
-- before a trait would fade. The shared half-life was the wrong tool (statuses
-- lingered for months), so status items decay on a much shorter half-life (a
-- fixed divisor in memoryWeight.ts) and are hard-expired from the store after
-- MEMORY_STATUS_TTL_DAYS (expireStatuses — deterministic, not model-judged).
-- Everything existing is a trait (the old behaviour, unchanged).
ALTER TABLE chat_memory_item
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'trait' CHECK (kind IN ('trait', 'status'));

-- 2) Profile cards («карточка»): the bot's own running 2-5 line portrait of the
-- chat ('' subject) and of each person (subject = their name; case-insensitive
-- folding of «гоша»/«Гоша» happens in the repo — SQLite's NOCASE is ASCII-only
-- and useless for Cyrillic). Unlike atomic memory items a card is a SYNTHESIS —
-- rewritten by a cheap model at episode close from the previous card + the new
-- episode notes + the current top facts (facts are ground truth and always win,
-- which is the anti-drift guard: the card is a derived view, never the source).
-- Failure to refresh keeps the old card; /profile <chatId> [clear] inspects/wipes.
CREATE TABLE IF NOT EXISTS chat_profile (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  subject    TEXT NOT NULL DEFAULT '', -- '' = the chat itself
  content    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (chat_id, subject)
);
