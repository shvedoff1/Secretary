import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { extractLexicon } from '../../llm/lexicon.js';
import {
  recordSample,
  sampleStats,
  claimSamples,
  recordTerms,
  staleSampleChats,
} from '../../db/repos/lexicon.repo.js';

/**
 * Decide whether to fire an extraction batch now: trigger once the buffer reaches
 * the batch size OR the oldest buffered message has aged past the max — whichever
 * comes first. An empty buffer never triggers.
 */
export function shouldExtract(
  stats: { count: number; oldestAt: number | null },
  opts: { batchSize: number; maxAgeMs: number },
  now: number,
): boolean {
  if (stats.count <= 0) return false;
  if (stats.count >= opts.batchSize) return true;
  if (stats.oldestAt !== null && now - stats.oldestAt >= opts.maxAgeMs) return true;
  return false;
}

/** Claim a chat's buffered samples and merge any extracted slang into its lexicon. */
export async function flushLexicon(chatId: number): Promise<void> {
  const samples = claimSamples(chatId);
  if (samples.length === 0) return;
  const terms = await extractLexicon(samples);
  if (terms.length > 0) recordTerms(chatId, terms);
}

/**
 * Note an incoming message for lexicon learning: buffer it, and if the batch
 * threshold is reached, extract and merge. Fully best-effort — any failure is
 * logged and swallowed so it can never affect the user's reply. Fire-and-forget.
 */
export async function learnFromMessage(chatId: number, text: string): Promise<void> {
  try {
    const cfg = loadConfig();
    if (!cfg.ENABLE_LEXICON) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    recordSample(chatId, trimmed);
    const ready = shouldExtract(sampleStats(chatId), {
      batchSize: cfg.LEXICON_BATCH_SIZE,
      maxAgeMs: cfg.LEXICON_MAX_AGE_HOURS * 3_600_000,
    }, Date.now());
    if (ready) await flushLexicon(chatId);
  } catch (err) {
    logger.warn({ err, chatId }, 'lexicon learning failed');
  }
}

/**
 * Periodic catch-up: extract for any chat whose buffer has gone stale (so the
 * "once a day" trigger still fires for chats that went quiet before reaching the
 * batch size). Best-effort.
 */
export async function flushStaleLexicons(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_LEXICON) return;
  const cutoff = Date.now() - cfg.LEXICON_MAX_AGE_HOURS * 3_600_000;
  let chats: number[];
  try {
    chats = staleSampleChats(cutoff);
  } catch (err) {
    logger.warn({ err }, 'failed to query stale lexicon samples');
    return;
  }
  for (const chatId of chats) {
    try {
      await flushLexicon(chatId);
    } catch (err) {
      logger.warn({ err, chatId }, 'stale lexicon flush failed');
    }
  }
}
