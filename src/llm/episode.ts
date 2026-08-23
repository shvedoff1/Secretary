import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

/** The condensed record of one finished conversation session. */
export interface EpisodeNotes {
  /** A few short lines of notes (facts kept, wording dropped). */
  summary: string;
  /** 2-6 lowercase topic tags for the context topic index and search. */
  topics: string[];
}

// Episodic memory's write path. Same discipline as the recap condenser
// (summarize.ts): this tier preserves, it never interprets — anything invented
// here would later be served back as the bot's own "memory" of the conversation.
const EPISODE_SYSTEM = `You are writing an assistant's EPISODIC MEMORY: the record of ONE finished group-chat
conversation, which will later be shown back to the assistant as "what was talked
about that time". You get the session's transcript ([time] Author: text, «Бот» is
the assistant itself).

Produce:
- "summary": 1-6 short plain-text lines, in the chat's own language — who said/did
  what (names as written), decisions and agreements, plans with dates/times/places,
  questions left open, notable facts and numbers. Drop greetings, filler and the
  exact wording. If the whole session is small talk with no substance, one line
  saying what the banter was about is enough.
- "topics": 2-6 SHORT lowercase tags (one or two words each, chat's language) naming
  what the session was about — e.g. ["поездка в далат", "серф", "днюха гоши"].

NEVER add anything that is not in the transcript. Output ONLY a JSON object, no
prose and no markdown fences:
{"summary":"строка 1\\nстрока 2","topics":["тема1","тема2"]}`;

/**
 * Parse the model's reply into episode notes. Defensive like parseReconcileJson:
 * the model may wrap the object in prose/fences; bad shape yields null so the
 * caller retries later instead of storing garbage as memory.
 */
export function parseEpisodeJson(text: string): EpisodeNotes | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = (parsed as { summary?: unknown }).summary;
  if (typeof summary !== 'string' || !summary.trim()) return null;
  const rawTopics = (parsed as { topics?: unknown }).topics;
  const topics = Array.isArray(rawTopics)
    ? rawTopics
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  return { summary: summary.trim(), topics };
}

/**
 * Compress one finished session's transcript into episode notes with the cheap
 * model. Best-effort: any failure (API error, unparseable output) returns null and
 * the closer leaves the episode unclosed to retry later — a failed call must never
 * advance the watermark past unsummarised messages.
 */
export async function summarizeEpisode(transcript: string): Promise<EpisodeNotes | null> {
  const text = transcript.trim();
  if (!text) return null;
  const cfg = loadConfig();
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_EPISODE_MODEL,
      max_tokens: 1024,
      // Deterministic: re-closing the same session (after a crash mid-tick) must
      // produce the same notes, not a different memory of the same evening.
      temperature: 0,
      system: EPISODE_SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
    const out = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const notes = parseEpisodeJson(out);
    if (!notes) logger.warn({ out: out.slice(0, 200) }, 'episode notes failed to parse');
    return notes;
  } catch (err) {
    logger.warn({ err }, 'episode summarisation failed');
    return null;
  }
}
