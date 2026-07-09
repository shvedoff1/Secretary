-- Per-chat persona (voice/style) selection. Stores the id of the persona preset
-- chosen with /style; NULL means "use the deployment default" (config DEFAULT_PERSONA,
-- itself falling back to 'neutral'). The style text lives in code
-- (src/persona/presets.ts), so only the id is persisted here.
ALTER TABLE chat_settings ADD COLUMN persona_id TEXT;
