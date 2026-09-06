// Collapse the SAME real-world event cached from several sources into one row.
//
// calendar_event is unique per (calendar_id, uid, starts_at), so a flight that
// sits in two connected calendars (a personal one and the airline's import, or
// the same calendar linked twice) came out of listEvents twice — the digest
// read «• 21:00 Flight EY 407 · • 21:00 Flight EY 407», the planner pinged it
// twice, and the advice model reasoned about "two flights". Identity here is
// what a PERSON sees as one event: the same title (case/space-insensitive) at
// the same instant. Of the copies, the richest one survives — the row with a
// description (booking details feed the advice line) and a location.

export interface DedupableEvent {
  title: string;
  location: string | null;
  description?: string | null;
  startsAt: number;
  allDay: boolean;
}

function identity(e: DedupableEvent): string {
  const title = e.title.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${e.allDay ? 'd' : 't'}:${e.startsAt}:${title}`;
}

function richness(e: DedupableEvent): number {
  return (e.description?.trim().length ?? 0) + (e.location ? 1 : 0);
}

/** Pure; order of first appearance is kept (the input is sorted by start). */
export function dedupeEvents<T extends DedupableEvent>(events: T[]): T[] {
  const byKey = new Map<string, number>();
  const out: T[] = [];
  for (const e of events) {
    const key = identity(e);
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(e);
    } else if (richness(e) > richness(out[at]!)) {
      out[at] = e;
    }
  }
  return out;
}
