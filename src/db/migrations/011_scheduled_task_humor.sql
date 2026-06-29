-- Per-task humor toggle. When a timer task fires and produces a plain-chat
-- answer, this flag decides whether that text is run through the optional
-- OpenAI tone-only humorizer (the same pass the live chat flow uses). Default 0
-- preserves the previous behavior — scheduled output was never humorized.
ALTER TABLE scheduled_task ADD COLUMN humor INTEGER NOT NULL DEFAULT 0;
