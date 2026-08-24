// Bounded fuzzy matching for PERSON NAMES, used when a name reaches us through a
// lossy channel — a voice transcript mangles them («Швец» for «Швед»), and people
// mistype them. The job is narrow: recognise that a name is a corrupted spelling of
// someone we ALREADY know, so the fact lands in that person's bucket instead of
// creating a phantom participant.
//
// Deliberately NOT a general similarity score. Russian given names sit one edit
// apart all the time («Аня»/«Ваня», «Дима»/«Рима»), so a loose matcher would merge
// two real people — a far worse failure than the phantom it prevents. Hence the
// hard floors below, and the caller's rule that an AMBIGUOUS match (more than one
// candidate near) resolves to nothing rather than to a guess.

/** Shortest name we will fuzzy-match at all: below this, one edit is a different person. */
const MIN_LENGTH = 4;
/** From this length on, two edits are still safely below "a different name". */
const TWO_EDIT_LENGTH = 8;
/**
 * Leading characters that must agree. Transcribers and typos corrupt the MIDDLE and
 * END of a name («Швед»→«Швец», «Шведов»→«Шведав»); a different first letter is a
 * different name. Without this, «Коля»/«Толя» and «Дима»/«Рима» — four letters, one
 * edit, two entirely different people — would merge.
 */
const MIN_SHARED_PREFIX = 2;

/** Lowercase, fold ё→е, collapse whitespace — the same shape names are compared in. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * Levenshtein distance, abandoned as soon as it provably exceeds `max`. Names are a
 * handful of characters, so the simple two-row form is plenty.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(d);
      if (d < best) best = d;
    }
    // Every remaining row can only add to the minimum, so a row already over the
    // budget means the final distance is too.
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/** How many edits we tolerate between two names of these lengths. */
function budgetFor(shorter: number): number {
  return shorter >= TWO_EDIT_LENGTH ? 2 : 1;
}

/** How many leading characters two strings agree on. */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Does `candidate` look like a mis-heard or mistyped spelling of `known`?
 *
 * Compares the full strings and also each side's individual tokens, so a garbled
 * first name still matches a "First Last" spelling («Швец» vs «Швед Иванов»). Both
 * sides must clear {@link MIN_LENGTH} — short names are excluded outright, which is
 * what keeps «Аня» and «Ваня» apart — and must agree on their first
 * {@link MIN_SHARED_PREFIX} characters, which is what keeps «Коля» and «Толя» apart.
 */
export function nearName(candidate: string, known: string): boolean {
  const a = normalize(candidate);
  const b = normalize(known);
  if (!a || !b) return false;
  if (a === b) return true;

  const partsA = [a, ...a.split(' ')];
  const partsB = [b, ...b.split(' ')];
  for (const x of partsA) {
    if (x.length < MIN_LENGTH) continue;
    for (const y of partsB) {
      if (y.length < MIN_LENGTH) continue;
      if (x === y) return true;
      if (sharedPrefix(x, y) < MIN_SHARED_PREFIX) continue;
      const max = budgetFor(Math.min(x.length, y.length));
      if (editDistance(x, y, max) <= max) return true;
    }
  }
  return false;
}
