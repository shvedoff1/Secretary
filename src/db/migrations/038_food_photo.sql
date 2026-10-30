-- Persist only a Telegram reference, never image bytes or a bot-token URL.
ALTER TABLE food_entry ADD COLUMN source_file_id TEXT;
ALTER TABLE food_entry ADD COLUMN source_media_type TEXT;
