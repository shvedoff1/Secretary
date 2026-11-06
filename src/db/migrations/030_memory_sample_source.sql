-- Which CHANNEL a buffered memory sample arrived through. A voice note reaches the
-- extractor as a machine transcript, and transcripts mangle names («Швец» for
-- «Швед») — a name the extractor then files a fact under, opening a person who does
-- not exist. Marking the channel lets the extractor prompt treat those names as
-- unreliable instead of authoritative. Existing rows are plain text.
ALTER TABLE chat_memory_sample ADD COLUMN source TEXT NOT NULL DEFAULT 'text';
