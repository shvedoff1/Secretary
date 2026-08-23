import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';
import type { MemoryItem, MemorySample } from '../db/repos/memoryItem.repo.js';
import { MIN_IMPORTANCE, MAX_IMPORTANCE } from '../util/memoryWeight.js';

/** A fact extracted from a batch, before its subject is resolved to a tg user id. */
export interface ExtractedFact {
  scope: 'chat' | 'user';
  /** Person name for user-scope facts ('' for chat-scope). */
  subject: string;
  content: string;
  importance: number;
  /** trait = durable knowledge (default); status = current, temporary state. */
  kind: 'trait' | 'status';
}

/** The extractor's output: new facts to add, plus ids of known facts re-mentioned. */
export interface MemoryExtraction {
  newItems: ExtractedFact[];
  reinforcedIds: number[];
}

const EMPTY: MemoryExtraction = { newItems: [], reinforcedIds: [] };

// The extractor maintains a compact long-term memory from a batch of (sender-labeled)
// messages plus the facts already known. It splits facts into shared chat-wide ones
// and per-person ones, scores their salience, and re-uses existing facts (by id)
// instead of duplicating them — the chief defense against the store filling with
// near-duplicate free text.
const MEMORY_EXTRACT_SYSTEM = `You maintain a compact, human-like long-term memory for a group chat.
You are given (1) the facts ALREADY known about this chat, each with an #id, and
(2) a new batch of messages, each prefixed with the sender's name.

Extract only facts worth remembering: stable preferences and habits, relationships,
roles, locations, plans, significant life events or decisions — and the group's or a
person's notable CURRENT state. Split them into:
- "chat" scope — facts about the GROUP as a whole (shared plans, the trip they're on,
  group-wide facts). Leave "subject" empty.
- "user" scope — facts about ONE person. Set "subject" to that person's name (use the
  sender name, or the named person the message is about).

Each fact also has a "kind":
- "trait" — durable, identity-level knowledge that stays true for months («серфит»,
  «живёт на Бали», «женат на Кате», «работает в крипте»). The default.
- "status" — a CURRENT, temporary state: true now, expected to change («сейчас во
  Вьетнаме до марта», «болеет», «на этой неделе завал на работе», «ищет квартиру»).
  Phrase a status so the time frame is visible («сейчас…», «в августе…»). Statuses
  fade from memory quickly by design — that is what makes them safe to keep.

DO NOT capture: ephemeral chatter, greetings, jokes, one-off moods («устал сегодня»),
logistics already handled elsewhere, money/expenses, or anything trivial. When in
doubt, omit — keep memory clean and small.

Score each new fact's "importance" 1..5: 1 = minor taste; 3 = stable preference/habit;
5 = major life event / decision / relationship change.

REINFORCE instead of duplicating: if a message merely restates or confirms a fact that
is already in the known list, DO NOT create a new item — put that fact's #id (number
only) into "reinforcedIds".

Output ONLY a JSON object (no prose, no markdown fences):
{"newItems":[{"scope":"chat|user","subject":"","content":"...","importance":3,"kind":"trait|status"}],"reinforcedIds":[12,7]}
At most 12 new items. If nothing qualifies, output {"newItems":[],"reinforcedIds":[]}.`;

/**
 * Parse the model's reply into a memory extraction. Best-effort and defensive: the
 * model may wrap the object in prose or fences, so we grab the outermost object and
 * salvage each entry independently. Anything unparseable yields an empty result
 * rather than throwing, so memory learning can never break the chat.
 */
export function parseMemoryJson(text: string, max = 12): MemoryExtraction {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { ...EMPTY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY };

  const rawItems = (parsed as { newItems?: unknown }).newItems;
  const newItems: ExtractedFact[] = [];
  if (Array.isArray(rawItems)) {
    for (const it of rawItems) {
      if (!it || typeof it !== 'object') continue;
      const content = (it as { content?: unknown }).content;
      if (typeof content !== 'string' || !content.trim()) continue;
      const scope = (it as { scope?: unknown }).scope === 'user' ? 'user' : 'chat';
      const subjRaw = (it as { subject?: unknown }).subject;
      const subject = scope === 'user' && typeof subjRaw === 'string' ? subjRaw.trim() : '';
      const impRaw = Number((it as { importance?: unknown }).importance);
      const importance = Number.isFinite(impRaw)
        ? Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, impRaw))
        : 3;
      // Anything that isn't explicitly a status stays a trait — the safe default
      // (a mis-kinded trait merely fades fast; the reverse would linger wrongly).
      const kind = (it as { kind?: unknown }).kind === 'status' ? 'status' : 'trait';
      newItems.push({ scope, subject, content: content.trim(), importance, kind });
      if (newItems.length >= max) break;
    }
  }

  const rawIds = (parsed as { reinforcedIds?: unknown }).reinforcedIds;
  const reinforcedIds: number[] = [];
  if (Array.isArray(rawIds)) {
    for (const id of rawIds) {
      const n = Number(id);
      if (Number.isInteger(n) && n > 0) reinforcedIds.push(n);
    }
  }

  return { newItems, reinforcedIds };
}

function renderKnown(known: MemoryItem[]): string {
  if (known.length === 0) return '(пока пусто)';
  return known
    .map((k) => {
      const who = k.scope === 'user' ? k.subject || 'участник' : 'чат';
      // Statuses are labelled so a re-mention reinforces the existing row (which
      // resets its decay clock — how an ONGOING state stays current) instead of
      // spawning a duplicate.
      const status = k.kind === 'status' ? ', статус' : '';
      return `#${k.id} [${who}${status}] ${k.content}`;
    })
    .join('\n');
}

/**
 * Extract durable facts from a batch of messages using a cheap model, given the
 * facts already known (so it can reinforce by id instead of duplicating). Best-effort:
 * any failure (no key, API error, bad output) returns an empty result.
 */
export async function extractMemory(
  samples: MemorySample[],
  known: MemoryItem[],
): Promise<MemoryExtraction> {
  if (samples.length === 0) return { ...EMPTY };
  const cfg = loadConfig();
  const userContent =
    `Известные факты:\n${renderKnown(known)}\n\n` +
    `Новые сообщения:\n${samples.map((s) => `${s.senderName}: ${s.content}`).join('\n')}`;
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_MEMORY_MODEL,
      max_tokens: 1024,
      system: MEMORY_EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return parseMemoryJson(text);
  } catch (err) {
    logger.warn({ err }, 'memory extraction failed');
    return { ...EMPTY };
  }
}
