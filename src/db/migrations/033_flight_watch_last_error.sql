-- Why a flight watch is failing. The poller kept only a COUNT of consecutive
-- feed failures, so the «не могу получить данные (уже 10 попыток)» warning
-- could not say what the feed answered — and the cause (a date outside the
-- provider's window, a spent quota, a timeout) lived only in the process log.
-- The last error message is now stored with the count, shown in the warning
-- and in /flight, and cleared by the next successful poll.
ALTER TABLE flight_watch ADD COLUMN last_error TEXT;
