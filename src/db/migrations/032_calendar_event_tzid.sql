-- The event's OWN timezone from the feed (DTSTART;TZID=…), when it had one.
-- Rendering fallback: while a chat hasn't set its timezone, showing event times
-- in UTC invents phantom discrepancies — a flight stored as 18:25 Asia/Saigon
-- (= 11:25 UTC) rendered as «11:25» reads as a different flight. With the source
-- zone kept, an unset-tz chat sees each event in the zone its calendar states
-- (for a flight that is the airport/ticket time). NULL = the feed gave none
-- (UTC "Z" times, floating times, all-day dates).
ALTER TABLE calendar_event ADD COLUMN tzid TEXT;
