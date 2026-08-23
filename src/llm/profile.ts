import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

/** A card the refresh pass wants created or overwritten. */
export interface ProfileCardDraft {
  /** '' for the chat card, else the person's name. */
  subject: string;
  content: string;
}

// The card rewriter. An LLM-maintained document that feeds back into itself every
// cycle is a hallucination-laundering machine unless it is fenced in, so the
// guardrails here are the point: facts are ground truth and always win over the
// old card, nothing may be invented, unchanged cards are OMITTED (not re-worded —
// re-wording is where drift creeps in), and the whole thing is a derived view
// that can be wiped and regenerated from the store at any time.
const PROFILE_SYSTEM = `You maintain short PROFILE CARDS for a group chat: one card for the chat itself and
one per person — the assistant's always-visible "who these people are" portrait.
You get:
1. CURRENT CARDS (may be empty or missing for some people).
2. NOTES of the conversation session(s) that just ended.
3. KNOWN FACTS from long-term memory — the GROUND TRUTH. A fact marked 📌 was
   pinned by a human; a fact marked (статус) is a current, temporary state.

Rewrite only the cards that the new notes or facts actually CHANGE, and create a
card for a person who clearly emerges in the inputs and has none. OMIT every card
that needs no change — omitted cards are kept as they are, word for word.

Card rules:
- 2-5 short lines in the chat's language, telegraphic («живёт на Бали; серфит;
  работает в крипте», «сейчас во Вьетнаме до марта»). Most identity-defining first;
  current state (if any) last, phrased so the time frame is visible.
- Build ONLY from the inputs. NEVER add anything the inputs do not say, never
  guess, never embellish. If in doubt, leave it out.
- FACTS OVERRIDE the old card: when a fact or a newer note contradicts a card
  line, the card line loses — rewrite or drop it. Drop lines whose "current state"
  is clearly over.
- The chat card ("subject": "") is about the GROUP: what this chat is, what it's
  living through, running plans. People cards use the name exactly as the inputs
  write it. No money/expense amounts on any card.

Output ONLY a JSON object (no prose, no markdown fences):
{"cards":[{"subject":"","content":"строка 1\\nстрока 2"},{"subject":"Гоша","content":"..."}]}
If nothing needs changing, output {"cards":[]}.`;

/**
 * Parse the model's reply into card drafts. Defensive like the other cheap-pass
 * parsers: bad shape yields null (keep the old cards), blank/oversized content is
 * trimmed or dropped, duplicate subjects collapse to the first occurrence.
 */
export function parseProfileJson(
  text: string,
  opts: { maxCards: number; maxChars: number },
): ProfileCardDraft[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const rawCards = (parsed as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(rawCards)) return null;
  const out: ProfileCardDraft[] = [];
  const seen = new Set<string>();
  for (const c of rawCards) {
    if (!c || typeof c !== 'object') continue;
    const subjRaw = (c as { subject?: unknown }).subject;
    const contentRaw = (c as { content?: unknown }).content;
    if (typeof subjRaw !== 'string' || typeof contentRaw !== 'string') continue;
    const subject = subjRaw.trim();
    const content = contentRaw.trim().slice(0, opts.maxChars);
    if (!content) continue;
    const key = subject.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject, content });
    if (out.length >= opts.maxCards) break;
  }
  return out;
}

/** How many cards one refresh may rewrite — a session touches a few people, not a crowd. */
const MAX_CARDS_PER_REFRESH = 8;

/**
 * Ask the cheap model which cards the just-closed session(s) change. Returns the
 * drafts to upsert (possibly empty — nothing changed), or null on any failure so
 * the caller keeps the old cards untouched.
 */
export async function refreshProfileCards(input: {
  cards: { subject: string; content: string }[];
  episodeNotes: string[];
  facts: string[];
}): Promise<ProfileCardDraft[] | null> {
  if (input.episodeNotes.length === 0) return [];
  const cfg = loadConfig();
  const renderedCards =
    input.cards.length === 0
      ? '(карточек пока нет)'
      : input.cards
          .map((c) => `[${c.subject || 'чат'}]\n${c.content}`)
          .join('\n\n');
  const userContent = [
    '=== ТЕКУЩИЕ КАРТОЧКИ ===',
    renderedCards,
    '',
    '=== ЗАМЕТКИ ЗАВЕРШИВШЕЙСЯ БЕСЕДЫ ===',
    input.episodeNotes.join('\n---\n'),
    '',
    '=== ИЗВЕСТНЫЕ ФАКТЫ (истина; при противоречии побеждают карточку) ===',
    input.facts.length > 0 ? input.facts.join('\n') : '(фактов нет)',
  ].join('\n');
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_PROFILE_MODEL,
      max_tokens: 1024,
      // Deterministic: the same close must produce the same cards, or two
      // restarts of one evening would remember two different chats.
      temperature: 0,
      system: PROFILE_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const cards = parseProfileJson(text, {
      maxCards: MAX_CARDS_PER_REFRESH,
      maxChars: cfg.PROFILE_CARD_MAX_CHARS,
    });
    if (!cards) logger.warn({ out: text.slice(0, 200) }, 'profile cards failed to parse');
    return cards;
  } catch (err) {
    logger.warn({ err }, 'profile refresh failed');
    return null;
  }
}
