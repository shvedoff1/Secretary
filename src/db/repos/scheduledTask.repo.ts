import { getDb } from '../client.js';

export interface ScheduledTask {
  id: number;
  chatId: number;
  tgUserId: number | null;
  title: string;
  prompt: string;
  cron: string;
  timezone: string;
  once: boolean;
  /** Run the firing task's plain-chat output through the OpenAI humorizer. */
  humor: boolean;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  createdAt: number;
}

interface ScheduledTaskRow {
  id: number;
  chat_id: number;
  tg_user_id: number | null;
  title: string;
  prompt: string;
  cron: string;
  timezone: string;
  once: number;
  humor: number;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  created_at: number;
}

function toTask(r: ScheduledTaskRow): ScheduledTask {
  return {
    id: r.id,
    chatId: r.chat_id,
    tgUserId: r.tg_user_id,
    title: r.title,
    prompt: r.prompt,
    cron: r.cron,
    timezone: r.timezone,
    once: r.once === 1,
    humor: r.humor === 1,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
  };
}

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Find an existing active task that is effectively the same as a candidate —
 * same schedule + same title. Guards against the model recreating a reminder it
 * already made (e.g. when the original request lingers in conversation history).
 * Pure function over a task list so it can be unit-tested without a DB.
 */
export function findDuplicate(
  tasks: ScheduledTask[],
  candidate: { cron: string; title: string },
): ScheduledTask | undefined {
  const t = normalizeTitle(candidate.title);
  return tasks.find(
    (task) =>
      task.enabled && task.cron === candidate.cron && normalizeTitle(task.title) === t,
  );
}

export function createTask(args: {
  chatId: number;
  tgUserId: number | null;
  title: string;
  prompt: string;
  cron: string;
  timezone: string;
  once: boolean;
  humor: boolean;
  nextRunAt: number;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO scheduled_task
         (chat_id, tg_user_id, title, prompt, cron, timezone, once, humor, enabled, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch() * 1000)`,
    )
    .run(
      args.chatId,
      args.tgUserId,
      args.title,
      args.prompt,
      args.cron,
      args.timezone,
      args.once ? 1 : 0,
      args.humor ? 1 : 0,
      args.nextRunAt,
    );
  return Number(info.lastInsertRowid);
}

/** Active tasks for a chat, soonest first. */
export function listTasks(chatId: number): ScheduledTask[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM scheduled_task
       WHERE chat_id = ? AND enabled = 1
       ORDER BY next_run_at ASC`,
    )
    .all(chatId) as ScheduledTaskRow[];
  return rows.map(toTask);
}

/** All enabled tasks whose next run is due (<= now). */
export function dueTasks(nowMs: number): ScheduledTask[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM scheduled_task
       WHERE enabled = 1 AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    )
    .all(nowMs) as ScheduledTaskRow[];
  return rows.map(toTask);
}

export function setNextRun(id: number, nextRunAt: number, lastRunAt: number): void {
  getDb()
    .prepare(
      'UPDATE scheduled_task SET next_run_at = ?, last_run_at = ? WHERE id = ?',
    )
    .run(nextRunAt, lastRunAt, id);
}

export function disableTask(id: number, lastRunAt?: number): void {
  if (lastRunAt !== undefined) {
    getDb()
      .prepare('UPDATE scheduled_task SET enabled = 0, last_run_at = ? WHERE id = ?')
      .run(lastRunAt, id);
  } else {
    getDb()
      .prepare('UPDATE scheduled_task SET enabled = 0 WHERE id = ?')
      .run(id);
  }
}

/** Delete a task, scoped to its chat so users can only cancel their own chat's tasks. */
export function deleteTask(id: number, chatId: number): boolean {
  const info = getDb()
    .prepare('DELETE FROM scheduled_task WHERE id = ? AND chat_id = ?')
    .run(id, chatId);
  return info.changes > 0;
}

/**
 * Toggle the humorizer for an existing task, scoped to its chat (users can only
 * change their own chat's tasks). Returns false when no such task exists in the
 * chat. Only enabled tasks are eligible — a cancelled task can't be re-tuned.
 */
export function setTaskHumor(id: number, chatId: number, humor: boolean): boolean {
  const info = getDb()
    .prepare(
      'UPDATE scheduled_task SET humor = ? WHERE id = ? AND chat_id = ? AND enabled = 1',
    )
    .run(humor ? 1 : 0, id, chatId);
  return info.changes > 0;
}
