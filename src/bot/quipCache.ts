// Process-local cache: a pre-generated comic riff for a pending expense, keyed by
// pendingId. It's filled in the BACKGROUND the moment a preview is shown, so the
// confirmation can render the joke instantly with no OpenAI round-trip on the
// button tap. In-memory is fine for a single-instance long-polling bot; a missing
// entry just means no joke (it's purely decorative).
//
// Abandoned previews (shown but never confirmed/cancelled) would otherwise leak
// entries, so the map is capped and evicts oldest-first once it grows too large.
const quips = new Map<string, string>();
const MAX_ENTRIES = 500;

export function setQuip(pendingId: string, quip: string): void {
  if (quips.size >= MAX_ENTRIES) {
    const oldest = quips.keys().next().value;
    if (oldest !== undefined) quips.delete(oldest);
  }
  quips.set(pendingId, quip);
}

/** Read and remove the cached quip (used once, on the successful confirmation). */
export function takeQuip(pendingId: string): string | undefined {
  const quip = quips.get(pendingId);
  quips.delete(pendingId);
  return quip;
}

export function clearQuip(pendingId: string): void {
  quips.delete(pendingId);
}
