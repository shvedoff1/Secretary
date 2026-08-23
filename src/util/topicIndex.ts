// Pure builder for the depth hint's topic index: a one-line answer to "what does
// the deep tier have material about?". Without it the model only knows HOW MUCH
// is hidden (N facts, M episodes) — with it, it knows there is something to
// recall about «поездка», «серф» or «Гоша» before deciding to search. People
// (memory subjects) come first — «что ты знаешь про X» is the flagship recall
// question — then conversation topics by how often they recur, newest-first on
// ties so a fresh theme beats an equally-frequent dead one.

/** Case-insensitive dedup that keeps the first spelling seen. */
function pushUnique(out: string[], seen: Set<string>, value: string): void {
  const key = value.trim().toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  out.push(value.trim());
}

export function buildTopicIndex(args: {
  /** Distinct per-person memory subjects (people the store knows something about). */
  subjects: readonly string[];
  /** Topic tags per episode, oldest episode first. */
  episodeTopics: readonly (readonly string[])[];
  max: number;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of args.subjects) {
    if (out.length >= args.max) return out;
    pushUnique(out, seen, s);
  }

  // Rank episode topics: frequency first, then recency (index of last appearance).
  const freq = new Map<string, { label: string; count: number; lastSeen: number }>();
  args.episodeTopics.forEach((topics, i) => {
    for (const t of topics) {
      const key = t.trim().toLowerCase();
      if (!key) continue;
      const cur = freq.get(key);
      if (cur) {
        cur.count++;
        cur.lastSeen = i;
      } else {
        freq.set(key, { label: t.trim(), count: 1, lastSeen: i });
      }
    }
  });
  const ranked = [...freq.values()].sort(
    (a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.label.localeCompare(b.label),
  );
  for (const t of ranked) {
    if (out.length >= args.max) break;
    pushUnique(out, seen, t.label);
  }
  return out;
}
