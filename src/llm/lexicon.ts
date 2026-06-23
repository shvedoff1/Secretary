import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';
import type { LexiconTerm } from '../db/repos/lexicon.repo.js';

// The extractor reads a batch of raw chat messages and pulls out the words that
// give the chat its voice. Kept narrow on purpose: standard vocabulary, names and
// one-off typos are noise and must be filtered out, or the lexicon fills with junk.
const EXTRACT_SYSTEM = `You analyze a batch of group-chat messages and extract the distinctive slang,
colloquialisms and deliberately distorted or playful word-forms THIS group uses —
the vocabulary that gives the chat its voice.

CAPTURE: shortened/altered forms (e.g. "тип" used for "типа"), affectionate or
playful variants (e.g. "братик" instead of "братуха"), in-group slang, recurring
catchphrases, characteristic interjections and filler words.

DO NOT capture: ordinary standard words, proper names / @usernames, obvious one-off
typos, pure profanity, links, numbers, or anything that appears only once and looks
accidental rather than stylistic.

Output ONLY a JSON array (no prose, no markdown fences) of objects:
{"term": <the word/phrase exactly as the group writes it>, "gloss": <very short note
in Russian: the meaning or the standard form it replaces>}.
At most 15 items — the most characteristic ones. If nothing qualifies, output [].`;

/**
 * Parse the model's reply into a clean term list. Best-effort and defensive: the
 * model may wrap the array in prose or fences, so we grab the outermost array and
 * validate each entry. Anything malformed yields an empty list rather than throwing.
 */
export function parseLexiconJson(text: string, max = 25): LexiconTerm[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: LexiconTerm[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const term = (item as { term?: unknown }).term;
    const gloss = (item as { gloss?: unknown }).gloss;
    if (typeof term !== 'string') continue;
    const trimmed = term.trim();
    if (!trimmed) continue;
    out.push({ term: trimmed, gloss: typeof gloss === 'string' ? gloss.trim() : '' });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Extract characteristic slang from a batch of messages using a cheap model.
 * Best-effort: any failure (no key, API error, bad output) returns an empty list,
 * so lexicon learning can never break the chat.
 */
export async function extractLexicon(samples: string[]): Promise<LexiconTerm[]> {
  if (samples.length === 0) return [];
  const cfg = loadConfig();
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_LEXICON_MODEL,
      max_tokens: 1024,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: samples.join('\n') }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return parseLexiconJson(text);
  } catch (err) {
    logger.warn({ err }, 'lexicon extraction failed');
    return [];
  }
}
