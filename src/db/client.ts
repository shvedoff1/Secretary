import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  const { DATABASE_PATH } = loadConfig();
  mkdirSync(dirname(DATABASE_PATH), { recursive: true });
  db = new Database(DATABASE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}
