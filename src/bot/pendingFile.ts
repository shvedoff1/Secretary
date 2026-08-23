import { loadConfig } from '../config.js';
import type { FileKind } from './media.js';

/**
 * The parked file. A document that arrives with no explanation («вот») is NOT
 * read — reading a PDF costs a chunk of the turn's budget, and nobody asked for
 * anything yet. Instead the bot asks what to do with it and parks the file_id
 * here; the user's next addressed message claims it and becomes the instruction
 * («вытащи оттуда суммы»), so the answer comes without them re-uploading.
 *
 * One slot per chat, in memory, with a TTL — same shape and same reasoning as
 * the forward batch (transient by design, per-chat ordering guaranteed by the
 * `sequentialize` middleware, a restart simply drops it). A second file replaces
 * the first: the question on screen is always about the newest one.
 */
export interface PendingFile {
  fileId: string;
  fileName: string;
  mimeType: string | undefined;
  kind: FileKind;
  /** The message the file arrived in — for the chat log / reply threading. */
  messageId: number;
}

interface Slot {
  file: PendingFile;
  timer: ReturnType<typeof setTimeout> | null;
}

const slots = new Map<number, Slot>();

/** Park a file and arm its expiry, replacing whatever was parked before. */
export function armPendingFile(chatId: number, file: PendingFile): void {
  const ttl = loadConfig().PENDING_FILE_TTL_MINUTES * 60_000;
  const prev = slots.get(chatId);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    slots.delete(chatId);
  }, ttl);
  timer.unref?.();
  slots.set(chatId, { file, timer });
}

/** Claim the parked file (and clear the slot) — null when nothing is waiting. */
export function takePendingFile(chatId: number): PendingFile | null {
  const slot = slots.get(chatId);
  if (!slot) return null;
  if (slot.timer) clearTimeout(slot.timer);
  slots.delete(chatId);
  return slot.file;
}

export function hasPendingFile(chatId: number): boolean {
  return slots.has(chatId);
}

/** Test hook: module-level state survives between vitest cases. */
export function resetPendingFiles(): void {
  for (const s of slots.values()) if (s.timer) clearTimeout(s.timer);
  slots.clear();
}
