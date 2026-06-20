import { getDb } from '../client.js';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'approved' | 'pending' | 'denied';

export interface UserRow {
  tg_user_id: number;
  username: string | null;
  display_name: string | null;
  role: UserRole;
  status: UserStatus;
  requested_at: number | null;
  decided_at: number | null;
  decided_by: number | null;
}

export function getUser(tgUserId: number): UserRow | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE tg_user_id = ?')
    .get(tgUserId) as UserRow | undefined;
}

export function isApproved(tgUserId: number): boolean {
  return getUser(tgUserId)?.status === 'approved';
}

export function isAdmin(tgUserId: number): boolean {
  return getUser(tgUserId)?.role === 'admin';
}

/** Insert the configured admin (idempotent) as an approved admin. */
export function ensureAdmin(tgUserId: number): void {
  getDb()
    .prepare(
      `INSERT INTO users (tg_user_id, role, status, decided_at)
       VALUES (?, 'admin', 'approved', unixepoch() * 1000)
       ON CONFLICT(tg_user_id) DO UPDATE SET role = 'admin', status = 'approved'`,
    )
    .run(tgUserId);
}

/** Record/refresh a pending access request. */
export function requestAccess(
  tgUserId: number,
  username: string | null,
  displayName: string | null,
): UserRow {
  const db = getDb();
  const existing = getUser(tgUserId);
  if (existing && existing.status === 'approved') return existing;
  db.prepare(
    `INSERT INTO users (tg_user_id, username, display_name, role, status, requested_at)
     VALUES (?, ?, ?, 'user', 'pending', unixepoch() * 1000)
     ON CONFLICT(tg_user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       status = 'pending',
       requested_at = unixepoch() * 1000`,
  ).run(tgUserId, username, displayName);
  return getUser(tgUserId)!;
}

export function setStatus(
  tgUserId: number,
  status: UserStatus,
  decidedBy: number,
): void {
  getDb()
    .prepare(
      `UPDATE users SET status = ?, decided_at = unixepoch() * 1000, decided_by = ?
       WHERE tg_user_id = ?`,
    )
    .run(status, decidedBy, tgUserId);
}

export function listPending(): UserRow[] {
  return getDb()
    .prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY requested_at")
    .all() as UserRow[];
}
