import { getDb } from '../client.js';
import type { MuteWindow } from '../../util/pingMute.js';

/**
 * Named ping lists per chat — the dota-mode roll call. `/dota` pings the default
 * list, `/dota <название>` a named one; the lists are edited with `/dota add`,
 * `/dota del`, `/dota clear` and browsed with `/dota lists`.
 *
 * Members are stored as display tokens exactly as typed (an `@username` actually
 * pings in Telegram; plain text is just shown), de-duplicated case-insensitively.
 * List names are normalized to trimmed lower-case so «Стак» and «стак» are the
 * same list regardless of how the SQLite NOCASE collation treats Cyrillic.
 */

/** The list `/dota` with no arguments pings. */
export const DEFAULT_PING_LIST = 'dota';

export interface PingList {
  name: string;
  members: string[];
}

function normName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Add members to a list (creating the list implicitly). Returns the members that
 * were actually added — ones already present (case-insensitively) are skipped.
 */
export function addPingMembers(
  chatId: number,
  listName: string,
  members: string[],
  addedBy: number,
): string[] {
  const db = getDb();
  const name = normName(listName);
  const stmt = db.prepare(
    `INSERT INTO ping_list_entry (chat_id, list_name, member, added_by, created_at)
     VALUES (?, ?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(chat_id, list_name, member) DO NOTHING`,
  );
  const added: string[] = [];
  const run = db.transaction((items: string[]) => {
    // Case-fold in JS: SQLite's NOCASE/lower() only folds ASCII, so «Коля» and
    // «коля» would slip past a SQL-side comparison. Seed with what's stored.
    const seen = new Set(
      (
        db
          .prepare(
            'SELECT member FROM ping_list_entry WHERE chat_id = ? AND list_name = ?',
          )
          .all(chatId, name) as { member: string }[]
      ).map((r) => r.member.toLowerCase()),
    );
    for (const raw of items) {
      const member = raw.trim();
      const key = member.toLowerCase();
      if (!member || seen.has(key)) continue;
      seen.add(key);
      stmt.run(chatId, name, member, addedBy);
      added.push(member);
    }
  });
  run(members);
  return added;
}

/**
 * Remove members from a list (matched case-insensitively). Returns the stored
 * member tokens that were actually removed.
 */
export function removePingMembers(
  chatId: number,
  listName: string,
  members: string[],
): string[] {
  const db = getDb();
  const name = normName(listName);
  const removed: string[] = [];
  const run = db.transaction((items: string[]) => {
    // Same JS-side case fold as addPingMembers (NOCASE won't fold Cyrillic).
    const rows = db
      .prepare(
        'SELECT id, member FROM ping_list_entry WHERE chat_id = ? AND list_name = ?',
      )
      .all(chatId, name) as { id: number; member: string }[];
    const byKey = new Map(rows.map((r) => [r.member.toLowerCase(), r]));
    for (const raw of items) {
      const key = raw.trim().toLowerCase();
      const existing = key ? byKey.get(key) : undefined;
      if (!existing) continue;
      byKey.delete(key);
      db.prepare('DELETE FROM ping_list_entry WHERE id = ?').run(existing.id);
      removed.push(existing.member);
    }
  });
  run(members);
  return removed;
}

/** Members of a list, in insertion order. Empty array when the list doesn't exist. */
export function getPingList(chatId: number, listName: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT member FROM ping_list_entry
       WHERE chat_id = ? AND list_name = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(chatId, normName(listName)) as { member: string }[];
  return rows.map((r) => r.member);
}

/** All lists in a chat with their members, alphabetically by name. */
export function listPingLists(chatId: number): PingList[] {
  const rows = getDb()
    .prepare(
      `SELECT list_name, member FROM ping_list_entry
       WHERE chat_id = ? ORDER BY list_name ASC, created_at ASC, id ASC`,
    )
    .all(chatId) as { list_name: string; member: string }[];
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    const list = byName.get(r.list_name) ?? [];
    list.push(r.member);
    byName.set(r.list_name, list);
  }
  return [...byName.entries()].map(([name, members]) => ({ name, members }));
}

/** Drop a whole list. Returns how many members it held. */
export function clearPingList(chatId: number, listName: string): number {
  const res = getDb()
    .prepare('DELETE FROM ping_list_entry WHERE chat_id = ? AND list_name = ?')
    .run(chatId, normName(listName));
  return res.changes;
}

// --- per-member quiet hours («не тегай меня до 19:00 по будням») -------------

/** Rule key: leading @ stripped + lower-cased, so «@Vasya» and «vasya» share
 *  rules and a rule applies to the member in EVERY list of the chat. */
export function muteKey(member: string): string {
  return member.trim().replace(/^@/, '').toLowerCase();
}

function dowMask(days: number[]): number {
  let mask = 0;
  for (const d of days) if (d >= 1 && d <= 7) mask |= 1 << (d - 1);
  return mask;
}

function maskDays(mask: number): number[] {
  const days: number[] = [];
  for (let d = 1; d <= 7; d++) if (mask & (1 << (d - 1))) days.push(d);
  return days;
}

/** Replace a member's quiet-hours windows (empty array clears them). */
export function setMuteRules(chatId: number, member: string, windows: MuteWindow[]): void {
  const db = getDb();
  const key = muteKey(member);
  const run = db.transaction(() => {
    db.prepare('DELETE FROM ping_mute_rule WHERE chat_id = ? AND member = ?').run(
      chatId,
      key,
    );
    const ins = db.prepare(
      `INSERT INTO ping_mute_rule (chat_id, member, dow_mask, from_min, to_min, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000)`,
    );
    for (const w of windows) {
      ins.run(chatId, key, dowMask(w.days), w.fromMin, w.toMin, w.timezone);
    }
  });
  run();
}

/** Drop a member's quiet hours. Returns how many windows were removed. */
export function clearMuteRules(chatId: number, member: string): number {
  return getDb()
    .prepare('DELETE FROM ping_mute_rule WHERE chat_id = ? AND member = ?')
    .run(chatId, muteKey(member)).changes;
}

/** A member's quiet-hours windows (empty when none). */
export function getMuteRules(chatId: number, member: string): MuteWindow[] {
  const rows = getDb()
    .prepare(
      `SELECT dow_mask, from_min, to_min, timezone FROM ping_mute_rule
       WHERE chat_id = ? AND member = ? ORDER BY id ASC`,
    )
    .all(chatId, muteKey(member)) as {
    dow_mask: number;
    from_min: number;
    to_min: number;
    timezone: string;
  }[];
  return rows.map((r) => ({
    days: maskDays(r.dow_mask),
    fromMin: r.from_min,
    toMin: r.to_min,
    timezone: r.timezone,
  }));
}

/** All quiet-hours rules in a chat, keyed by normalized member. */
export function listMuteRules(chatId: number): Map<string, MuteWindow[]> {
  const rows = getDb()
    .prepare(
      `SELECT member, dow_mask, from_min, to_min, timezone FROM ping_mute_rule
       WHERE chat_id = ? ORDER BY member ASC, id ASC`,
    )
    .all(chatId) as {
    member: string;
    dow_mask: number;
    from_min: number;
    to_min: number;
    timezone: string;
  }[];
  const out = new Map<string, MuteWindow[]>();
  for (const r of rows) {
    const list = out.get(r.member) ?? [];
    list.push({
      days: maskDays(r.dow_mask),
      fromMin: r.from_min,
      toMin: r.to_min,
      timezone: r.timezone,
    });
    out.set(r.member, list);
  }
  return out;
}
