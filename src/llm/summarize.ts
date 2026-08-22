import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

// The cheap first tier of the chat recap. A 500-message window is far too much
// transcript to hand the main model verbatim, so the OLDER part of it is
// compressed here — one call per chunk, in parallel — into dense notes the main
// model then writes the actual recap from. This tier must never interpret or
// editorialise: it drops wording, not facts, and inventing something here would
// be invisible to the tier above.
const CONDENSE_SYSTEM = `You compress a fragment of a group chat into dense notes for another
assistant, which will write the final recap from your output. You are NOT writing
the recap — you are preserving what happened in as few words as possible.

KEEP, in the chat's own language: who said/did what (names as written), decisions
and agreements, plans with dates/times/places, questions left open, numbers, sums,
links, @handles and any concrete detail someone might ask about later. Keep the
chronological order, and keep the day separators («— 21 августа —») you were given.

DROP: greetings, filler, emoji, repeated jokes, back-and-forth that led nowhere,
and the exact wording of everything.

Output ONLY the notes as short plain-text lines (one fact per line, «Имя: …» where
the speaker matters). No preamble, no markdown headings, no summary of your own.
NEVER add anything that is not in the fragment — if a stretch of it is pure noise,
write nothing for it.`;

/**
 * Compress one rendered transcript chunk. Best-effort: any failure (API error,
 * empty output) returns null so the caller can report the gap instead of silently
 * presenting a partial window as complete.
 */
export async function condenseChunk(chunk: string): Promise<string | null> {
  const text = chunk.trim();
  if (!text) return null;
  const cfg = loadConfig();
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_SUMMARY_MODEL,
      max_tokens: 2048,
      // Deterministic: the same window asked twice should compress the same way,
      // otherwise two recaps of one evening disagree on details.
      temperature: 0,
      system: CONDENSE_SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
    const out = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return out || null;
  } catch (err) {
    logger.warn({ err }, 'summary condense failed');
    return null;
  }
}

export interface CondensedChunks {
  /** Notes for the chunks that compressed, oldest first. */
  notes: string[];
  /** How many chunks failed (their content is NOT in `notes`). */
  failed: number;
}

/**
 * Compress every chunk in parallel. Chunks are independent by construction (each
 * is its own stretch of the conversation), so this costs one round-trip, not N.
 */
export async function condenseChunks(chunks: string[]): Promise<CondensedChunks> {
  const results = await Promise.all(chunks.map((chunk) => condenseChunk(chunk)));
  return {
    notes: results.filter((r): r is string => r !== null),
    failed: results.filter((r) => r === null).length,
  };
}
