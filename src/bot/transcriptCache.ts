// Process-local cache of voice-note transcripts, keyed by `${chatId}:${messageId}`.
// Telegram voice messages carry no text/caption, so when a user later REPLIES to a
// voice note (e.g. «запомни, это трата» / «это была трата»), the reply handler has
// no way to see what was said. We stash each transcript here when we transcribe it,
// so the reply handler can recover it and feed it to the assistant as context.
// In-memory is fine for a single-instance bot; a miss (old note, or after a restart)
// just means no context. Capped with oldest-first eviction so it can't grow forever.
const transcripts = new Map<string, string>();
const MAX_ENTRIES = 1000;

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function setTranscript(chatId: number, messageId: number, transcript: string): void {
  if (transcripts.size >= MAX_ENTRIES) {
    const oldest = transcripts.keys().next().value;
    if (oldest !== undefined) transcripts.delete(oldest);
  }
  transcripts.set(key(chatId, messageId), transcript);
}

export function getTranscript(chatId: number, messageId: number): string | undefined {
  return transcripts.get(key(chatId, messageId));
}
