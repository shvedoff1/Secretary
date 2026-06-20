import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { getDb } from './client.js';
import { logger } from '../logger.js';

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

function currentVersion(db: Database.Database): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)',
  );
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null };
  return row.v ?? 0;
}

/** Apply any migration files whose numeric prefix is newer than the recorded version. */
export function migrate(): void {
  const db = getDb();
  const applied = currentVersion(db);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const match = /^(\d+)/.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    if (version <= applied) continue;

    const sql = readFileSync(`${migrationsDir}${file}`, 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });
    run();
    logger.info({ file, version }, 'applied migration');
  }
}
