// Pure episode-boundary detection. No DB, no clock of its own — the closer hands
// in the unclosed log timestamps and "now", and gets back which stretches form
// finished conversation sessions. Deliberately derived from the log's own
// timestamps rather than in-memory timers (the chime's approach): timers die with
// the process, while re-deriving boundaries every tick is idempotent and survives
// restarts.

/** An index range [start..end] (inclusive) into the caller's message array. */
export interface ClosedSegment {
  start: number;
  end: number;
}

/**
 * Split the unclosed messages of a chat into finished sessions.
 *
 * A session boundary is a silence of `quietMs` or more between consecutive
 * messages. The trailing run stays OPEN (it is the conversation that may still be
 * going) unless `now` is already `quietMs` past its last message. A finished run
 * with fewer than `minMessages` lines is not worth an episode of its own — it is
 * folded FORWARD into the next run (a stray «ок» becomes the pre-chatter of the
 * next conversation), and if there is no next run yet it stays open and waits.
 *
 * `timestamps` must be ascending (the order chat_message_log is read in).
 */
export function segmentEpisodes(
  timestamps: readonly number[],
  opts: { now: number; quietMs: number; minMessages: number },
): ClosedSegment[] {
  if (timestamps.length === 0) return [];

  // 1. Runs split by silence gaps.
  const runs: ClosedSegment[] = [];
  let start = 0;
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i]! - timestamps[i - 1]! >= opts.quietMs) {
      runs.push({ start, end: i - 1 });
      start = i;
    }
  }
  runs.push({ start, end: timestamps.length - 1 });

  // 2. The trailing run is closed only once the chat has actually gone quiet.
  const lastTs = timestamps[timestamps.length - 1]!;
  const tailClosed = opts.now - lastTs >= opts.quietMs;
  const closedRuns = tailClosed ? runs : runs.slice(0, -1);

  // 3. Fold sub-minimum runs forward. Walking backwards keeps it single-pass:
  //    a tiny run merges into whatever already follows it (which may itself have
  //    absorbed tiny runs). A tiny run with nothing after it is left open — it
  //    will be re-read next tick and join the next conversation when it comes.
  const merged: ClosedSegment[] = [];
  for (let i = closedRuns.length - 1; i >= 0; i--) {
    const run = closedRuns[i]!;
    const count = run.end - run.start + 1;
    if (count >= opts.minMessages) {
      merged.push(run);
      continue;
    }
    const next = merged[merged.length - 1];
    // Merge only into a segment that directly (or via earlier merges) follows this run in
    // the SAME closed set; a tiny trailing run (or one followed only by the open
    // tail) has nowhere to go and stays pending.
    if (next && next.start === run.end + 1) {
      next.start = run.start;
    } else if (next) {
      // Non-adjacent should be impossible (runs partition the array), but stay
      // safe: prepend into the following segment anyway.
      next.start = Math.min(next.start, run.start);
    }
    // No following closed segment → drop (stays unclosed for a future tick).
  }
  return merged.reverse();
}
