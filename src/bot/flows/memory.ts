import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { extractMemory, type ExtractedFact } from '../../llm/memory.js';
import { effectiveWeight } from '../../util/memoryWeight.js';
import {
  recordSample,
  sampleStats,
  claimSamples,
  staleSampleChats,
  getAllItems,
  recordMemoryItems,
  reinforceItems,
  pruneMemory,
  type MemoryDraft,
  type MemorySample,
} from '../../db/repos/memoryItem.repo.js';
// shouldExtract is pure and generic (count/age threshold) — reuse it rather than
// duplicate the trigger logic.
import { shouldExtract } from './lexicon.js';

// How many of the chat's top-weighted facts to show the extractor so it can
// reinforce-by-id instead of duplicating. A module constant to avoid config sprawl.
const EXTRACT_KNOWN_CONTEXT = 40;

/** A unique sender (name + id) seen in a claimed batch, for subject resolution. */
interface Sender {
  tgUserId: number;
  name: string;
}

function sendersOf(samples: MemorySample[]): Sender[] {
  const byId = new Map<number, string>();
  for (const s of samples) if (!byId.has(s.tgUserId)) byId.set(s.tgUserId, s.senderName);
  return [...byId].map(([tgUserId, name]) => ({ tgUserId, name }));
}

/**
 * Resolve a person name the extractor produced to a tg user id from the batch's
 * senders. Tries exact, then token, then prefix match (the extractor may use a first
 * name while the sender is "First Last", or vice versa). Returns null if no match —
 * the fact is still kept as an unkeyed user fact.
 */
export function resolveSubject(subject: string, senders: Sender[]): number | null {
  const s = subject.trim().toLowerCase();
  if (!s) return null;
  for (const sender of senders) {
    if (sender.name.trim().toLowerCase() === s) return sender.tgUserId;
  }
  for (const sender of senders) {
    const tokens = sender.name.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.includes(s)) return sender.tgUserId;
  }
  for (const sender of senders) {
    const n = sender.name.trim().toLowerCase();
    if (n && (n.startsWith(s) || s.startsWith(n))) return sender.tgUserId;
  }
  return null;
}

function toDraft(fact: ExtractedFact, senders: Sender[]): MemoryDraft {
  if (fact.scope !== 'user') {
    return { scope: 'chat', tgUserId: null, subject: '', content: fact.content, importance: fact.importance };
  }
  return {
    scope: 'user',
    tgUserId: resolveSubject(fact.subject, senders),
    subject: fact.subject,
    content: fact.content,
    importance: fact.importance,
  };
}

/** Claim a chat's buffered samples and merge any extracted facts into its memory. */
export async function flushMemory(chatId: number): Promise<void> {
  const samples = claimSamples(chatId);
  if (samples.length === 0) return;
  const cfg = loadConfig();

  // Send the extractor the chat's strongest existing facts so it can reinforce them.
  const now = Date.now();
  const known = getAllItems(chatId)
    .sort((a, b) => effectiveWeight(b, now, cfg.MEMORY_HALFLIFE_DAYS) - effectiveWeight(a, now, cfg.MEMORY_HALFLIFE_DAYS))
    .slice(0, EXTRACT_KNOWN_CONTEXT);

  const extraction = await extractMemory(samples, known);
  const senders = sendersOf(samples);
  const drafts = extraction.newItems.map((f) => toDraft(f, senders));

  if (drafts.length > 0) recordMemoryItems(chatId, drafts);
  if (extraction.reinforcedIds.length > 0) reinforceItems(chatId, extraction.reinforcedIds);
  pruneMemory(chatId, cfg.MEMORY_MAX_ITEMS, cfg.MEMORY_HALFLIFE_DAYS);
}

/**
 * Note an incoming message for memory learning: buffer it (with its sender), and if
 * the batch threshold is reached, extract and merge. Fully best-effort — any failure
 * is logged and swallowed so it can never affect the user's reply. Fire-and-forget.
 */
export async function learnMemoryFromMessage(
  chatId: number,
  tgUserId: number,
  senderName: string,
  text: string,
): Promise<void> {
  try {
    const cfg = loadConfig();
    if (!cfg.ENABLE_MEMORY) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    recordSample(chatId, tgUserId, senderName, trimmed);
    const ready = shouldExtract(
      sampleStats(chatId),
      { batchSize: cfg.MEMORY_BATCH_SIZE, maxAgeMs: cfg.MEMORY_MAX_AGE_HOURS * 3_600_000 },
      Date.now(),
    );
    if (ready) await flushMemory(chatId);
  } catch (err) {
    logger.warn({ err, chatId }, 'memory learning failed');
  }
}

/**
 * Periodic catch-up: extract for any chat whose buffer has gone stale (so the
 * "once a day" trigger still fires for chats that went quiet before reaching the
 * batch size). Best-effort.
 */
export async function flushStaleMemories(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_MEMORY) return;
  const cutoff = Date.now() - cfg.MEMORY_MAX_AGE_HOURS * 3_600_000;
  let chats: number[];
  try {
    chats = staleSampleChats(cutoff);
  } catch (err) {
    logger.warn({ err }, 'failed to query stale memory samples');
    return;
  }
  for (const chatId of chats) {
    try {
      await flushMemory(chatId);
    } catch (err) {
      logger.warn({ err, chatId }, 'stale memory flush failed');
    }
  }
}
