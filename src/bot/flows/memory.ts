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
  expireStatuses,
  type MemoryDraft,
  type MemorySample,
  type MemorySampleSource,
} from '../../db/repos/memoryItem.repo.js';
// shouldExtract is pure and generic (count/age threshold) — reuse it rather than
// duplicate the trigger logic.
import { shouldExtract } from './lexicon.js';
import { nearName } from '../../util/nameMatch.js';

// How many of the chat's top-weighted facts to show the extractor so it can
// reinforce-by-id instead of duplicating. A module constant to avoid config sprawl.
const EXTRACT_KNOWN_CONTEXT = 40;

/**
 * Someone the subject can resolve to: a sender of the batch (always has a tg id) or
 * a person the store already holds facts about (may have none, if they never speak).
 */
export interface SubjectCandidate {
  tgUserId: number | null;
  name: string;
}

/** Where a fact's subject landed: whose it is, and under which spelling to file it. */
export interface ResolvedSubject {
  tgUserId: number | null;
  /**
   * The name to STORE. Same as the extractor wrote it on every exact-ish path; on the
   * fuzzy path it is the known person's spelling, so a mis-heard «Швец» folds into
   * «Швед»'s bucket instead of opening a second one next to it.
   */
  subject: string;
}

function sendersOf(samples: MemorySample[]): SubjectCandidate[] {
  const byId = new Map<number, string>();
  for (const s of samples) if (!byId.has(s.tgUserId)) byId.set(s.tgUserId, s.senderName);
  return [...byId].map(([tgUserId, name]) => ({ tgUserId, name }));
}

/**
 * People the chat's store already knows by name, newest weight order irrelevant —
 * this is only a name index. Used as fuzzy-match targets so a garbled spelling folds
 * into the person it belongs to even when they are not in the current batch.
 */
export function knownPeopleOf(items: { scope: string; subject: string; tgUserId: number | null }[]): SubjectCandidate[] {
  const out: SubjectCandidate[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (i.scope !== 'user') continue;
    const name = i.subject.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tgUserId: i.tgUserId, name });
  }
  return out;
}

/** Collapse candidates that are the same person by name, keeping the identified one. */
function dedupeCandidates(candidates: SubjectCandidate[]): SubjectCandidate[] {
  const byName = new Map<string, SubjectCandidate>();
  for (const c of candidates) {
    const key = c.name.trim().toLowerCase();
    if (!key) continue;
    const cur = byName.get(key);
    if (!cur || (cur.tgUserId === null && c.tgUserId !== null)) byName.set(key, c);
  }
  return [...byName.values()];
}

/**
 * Resolve a person name the extractor produced to one of `candidates` — the batch's
 * senders first, then people the store already knows. Tries exact, then token, then
 * prefix match (the extractor may use a first name while the sender is "First Last",
 * or vice versa), and finally a BOUNDED fuzzy match for names that arrived through a
 * lossy channel: a voice transcript writes «Швец» where the chat means «Швед», and
 * without this the fact opens a phantom person that never merges back.
 *
 * The fuzzy step is deliberately timid. It only fires when EXACTLY ONE candidate is
 * near — two near names mean we cannot tell which person is meant, and inventing the
 * wrong attribution is worse than leaving the fact unkeyed (same rule as removing a
 * chat rule by an ambiguous quote). It also never invents a NEW person: an unfamiliar
 * name («Гоша», a brother nobody in the chat is) stays exactly as written, which is
 * how facts about non-participants keep working.
 */
export function resolveSubject(
  subject: string,
  candidates: SubjectCandidate[],
): ResolvedSubject {
  const kept = subject.trim();
  const miss: ResolvedSubject = { tgUserId: null, subject: kept };
  const s = kept.toLowerCase();
  if (!s) return miss;

  const people = dedupeCandidates(candidates);

  for (const p of people) {
    if (p.name.trim().toLowerCase() === s) return { tgUserId: p.tgUserId, subject: kept };
  }
  for (const p of people) {
    const tokens = p.name.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.includes(s)) return { tgUserId: p.tgUserId, subject: kept };
  }
  for (const p of people) {
    const n = p.name.trim().toLowerCase();
    if (n && (n.startsWith(s) || s.startsWith(n))) return { tgUserId: p.tgUserId, subject: kept };
  }

  const near = people.filter((p) => nearName(kept, p.name));
  if (near.length === 1) {
    // Store the KNOWN spelling: the whole point is not to open a second bucket.
    return { tgUserId: near[0]!.tgUserId, subject: near[0]!.name };
  }
  return miss;
}

function toDraft(fact: ExtractedFact, candidates: SubjectCandidate[]): MemoryDraft {
  if (fact.scope !== 'user') {
    return {
      scope: 'chat',
      tgUserId: null,
      subject: '',
      content: fact.content,
      importance: fact.importance,
      kind: fact.kind,
    };
  }
  const who = resolveSubject(fact.subject, candidates);
  return {
    scope: 'user',
    tgUserId: who.tgUserId,
    subject: who.subject,
    content: fact.content,
    importance: fact.importance,
    kind: fact.kind,
  };
}

/** Claim a chat's buffered samples and merge any extracted facts into its memory. */
export async function flushMemory(chatId: number): Promise<void> {
  const samples = claimSamples(chatId);
  if (samples.length === 0) return;
  const cfg = loadConfig();

  // Send the extractor the chat's strongest existing facts so it can reinforce them.
  const now = Date.now();
  const stored = getAllItems(chatId);
  const known = [...stored]
    .sort((a, b) => effectiveWeight(b, now, cfg.MEMORY_HALFLIFE_DAYS) - effectiveWeight(a, now, cfg.MEMORY_HALFLIFE_DAYS))
    .slice(0, EXTRACT_KNOWN_CONTEXT);

  const extraction = await extractMemory(samples, known);
  // Senders first (they carry a real tg id), then everyone the store already knows by
  // name — that second group is what lets a garbled spelling fold into the right
  // person even when they said nothing in this batch. Note this reads the FULL store,
  // not the top-40 slice above: a decayed person is still that person.
  const candidates = [...sendersOf(samples), ...knownPeopleOf(stored)];
  const drafts = extraction.newItems.map((f) => toDraft(f, candidates));

  if (drafts.length > 0) recordMemoryItems(chatId, drafts);
  if (extraction.reinforcedIds.length > 0) reinforceItems(chatId, extraction.reinforcedIds);
  // Statuses past their shelf life leave the store outright (a stale "current
  // state" is misinformation, not a memory), then the usual volume prune.
  const expired = expireStatuses(chatId, cfg.MEMORY_STATUS_TTL_DAYS);
  if (expired > 0) logger.debug({ chatId, expired }, 'expired stale status facts');
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
  /** Channel it arrived on — 'voice' marks a machine transcript (mangled names). */
  source: MemorySampleSource = 'text',
): Promise<void> {
  try {
    const cfg = loadConfig();
    if (!cfg.ENABLE_MEMORY) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    recordSample(chatId, tgUserId, senderName, trimmed, source);
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
