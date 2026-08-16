import { getDb } from '../client.js';
import { logger } from '../../logger.js';

// Storage for the Dota knowledge base (see src/dota/). Global reference data,
// not per-chat: the game is the same in every chat.

export type DotaKind = 'hero' | 'item' | 'patch';

export interface DotaEntity {
  id: number;
  kind: DotaKind;
  key: string;
  feedId: number | null;
  name: string;
  card: string;
  summary: string;
  search: string;
  patch: string;
}

/** A row as the sync produces it, before it gets an id. */
export interface DotaEntityInput {
  kind: DotaKind;
  key: string;
  feedId?: number | null;
  name: string;
  card: string;
  summary: string;
  search: string;
}

export interface DotaSyncState {
  patch: string | null;
  lastFullSync: number | null;
  lastCheck: number | null;
  lastError: string | null;
}

interface EntityRow {
  id: number;
  kind: DotaKind;
  key: string;
  feed_id: number | null;
  name: string;
  card: string;
  summary: string;
  search: string;
  patch: string;
}

function toEntity(r: EntityRow): DotaEntity {
  return {
    id: r.id,
    kind: r.kind,
    key: r.key,
    feedId: r.feed_id,
    name: r.name,
    card: r.card,
    summary: r.summary,
    search: r.search,
    patch: r.patch,
  };
}

/**
 * Fold a name to its lookup form: case, spacing, punctuation and the
 * npc_dota_hero_/item_ prefixes all vary between how Valve spells a name, how
 * the model passes it and how a person types it. "Anti-Mage", "anti mage",
 * "antimage" and "npc_dota_hero_antimage" must all land on the same row.
 */
export function normalizeDotaName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^npc_dota_hero_/, '')
    .replace(/^item_/, '')
    .replace(/[^a-zа-яё0-9]+/gi, '');
}

function aliasesFor(input: DotaEntityInput): string[] {
  const bare = input.key.replace(/^npc_dota_hero_/, '').replace(/^item_/, '');
  const candidates = [input.name, input.key, bare.replace(/_/g, ' ')];
  return [...new Set(candidates.map(normalizeDotaName).filter((a) => a.length > 0))];
}

/**
 * Swap the whole knowledge base for a freshly synced one, in ONE transaction:
 * entities, their lookup aliases and the FTS index are rebuilt together, so a
 * failed sync leaves the previous (working) patch in place rather than a
 * half-written mix, and the FTS index can never drift from the rows.
 *
 * Repeated (kind, key) pairs are dropped rather than thrown at the UNIQUE
 * constraint: one duplicate would abort the transaction and take the ENTIRE
 * base down with it (heroes and items included) over what is, by definition, a
 * row we already have. The sync keys entities by feed id precisely so this stays
 * a last-resort guard against a feed that lists the same id twice.
 */
export function replaceDotaEntities(
  entities: DotaEntityInput[],
  patch: string,
  now = Date.now(),
): number {
  const db = getDb();
  const unique: DotaEntityInput[] = [];
  const takenKeys = new Set<string>();
  for (const e of entities) {
    const dedupeKey = `${e.kind}:${e.key}`;
    if (takenKeys.has(dedupeKey)) {
      logger.warn({ kind: e.kind, key: e.key, name: e.name }, 'dota: duplicate entity key dropped');
      continue;
    }
    takenKeys.add(dedupeKey);
    unique.push(e);
  }
  const run = db.transaction(() => {
    db.exec('DELETE FROM dota_alias');
    db.exec('DELETE FROM dota_fts');
    db.exec('DELETE FROM dota_entity');
    const insertEntity = db.prepare(
      `INSERT INTO dota_entity (kind, key, feed_id, name, card, summary, search, patch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAlias = db.prepare(
      'INSERT OR IGNORE INTO dota_alias (alias, entity_id) VALUES (?, ?)',
    );
    const insertFts = db.prepare(
      'INSERT INTO dota_fts (name, body, entity_id) VALUES (?, ?, ?)',
    );
    for (const e of unique) {
      const info = insertEntity.run(
        e.kind,
        e.key,
        e.feedId ?? null,
        e.name,
        e.card,
        e.summary,
        e.search,
        patch,
        now,
      );
      const id = Number(info.lastInsertRowid);
      for (const alias of aliasesFor(e)) insertAlias.run(alias, id);
      insertFts.run(e.name, e.search, id);
    }
  });
  run();
  return unique.length;
}

/** Exact lookup by any known alias. `kind` null searches heroes and items. */
export function findDotaEntity(name: string, kind?: DotaKind | null): DotaEntity | null {
  const alias = normalizeDotaName(name);
  if (!alias) return null;
  const db = getDb();
  const sql = `SELECT e.* FROM dota_entity e
      JOIN dota_alias a ON a.entity_id = e.id
      WHERE a.alias = ?${kind ? ' AND e.kind = ?' : " AND e.kind <> 'patch'"}
      LIMIT 1`;
  const row = (kind
    ? db.prepare(sql).get(alias, kind)
    : db.prepare(sql).get(alias)) as EntityRow | undefined;
  return row ? toEntity(row) : null;
}

/**
 * Freetext search, used for "which items give X" questions and as the
 * did-you-mean fallback when an exact name lookup misses. The query is fed to
 * FTS5 as a bag of prefix terms — user phrasing is not FTS syntax, and an
 * unescaped quote or `*` would otherwise blow up the query.
 */
export function searchDotaEntities(
  query: string,
  limit = 5,
  kind?: DotaKind | null,
): DotaEntity[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((t) => t.length > 1)
    .slice(0, 8);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t}"*`).join(' OR ');
  const db = getDb();
  try {
    const rows = db
      .prepare(
        `SELECT e.* FROM dota_fts f
         JOIN dota_entity e ON e.id = f.entity_id
         WHERE dota_fts MATCH ?${kind ? ' AND e.kind = ?' : ''}
         ORDER BY bm25(dota_fts, 10.0, 1.0)
         LIMIT ?`,
      )
      .all(...(kind ? [match, kind, limit] : [match, limit])) as EntityRow[];
    return rows.map(toEntity);
  } catch {
    // A malformed MATCH must degrade to "no results", never break the turn.
    return [];
  }
}

export function countDotaEntities(): Record<DotaKind, number> {
  const rows = getDb()
    .prepare('SELECT kind, COUNT(*) AS n FROM dota_entity GROUP BY kind')
    .all() as { kind: DotaKind; n: number }[];
  const counts: Record<DotaKind, number> = { hero: 0, item: 0, patch: 0 };
  for (const r of rows) counts[r.kind] = r.n;
  return counts;
}

export function getDotaSyncState(): DotaSyncState {
  const row = getDb()
    .prepare('SELECT patch, last_full_sync, last_check, last_error FROM dota_sync_state WHERE id = 1')
    .get() as
    | { patch: string | null; last_full_sync: number | null; last_check: number | null; last_error: string | null }
    | undefined;
  return {
    patch: row?.patch ?? null,
    lastFullSync: row?.last_full_sync ?? null,
    lastCheck: row?.last_check ?? null,
    lastError: row?.last_error ?? null,
  };
}

export function setDotaSyncState(patch: Partial<DotaSyncState>): void {
  const current = getDotaSyncState();
  const next = { ...current, ...patch };
  getDb()
    .prepare(
      `INSERT INTO dota_sync_state (id, patch, last_full_sync, last_check, last_error)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         patch = excluded.patch,
         last_full_sync = excluded.last_full_sync,
         last_check = excluded.last_check,
         last_error = excluded.last_error`,
    )
    .run(next.patch, next.lastFullSync, next.lastCheck, next.lastError);
}
