import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { reasoningField, humorTimeoutSignal } from './openaiOptions.js';
import type { HumorLexiconTerm } from './humorize.js';

/**
 * Slang pass — the chat's learned lingo applied to a reply that the humorizer
 * does NOT touch.
 *
 * Until now the lexicon rode along only inside the humorizer, so slang existed
 * only where jokes were allowed: `ENABLE_HUMOR` on, the chat's humour not
 * switched off, and the answer plain-chat (no tool, no money). Everything
 * behind that guard — dota cards, surf forecasts, spending digests, reminder
 * confirmations — came back in neutral bot Russian.
 *
 * This module is the other half: a VOCABULARY-only rewrite that swaps wording
 * for the group's own words while leaving every fact, number and line of
 * structure exactly as it was. It is deliberately NOT the humorizer — no jokes,
 * no riffing, no emoji, no re-ordering — so it is safe to run on the exact
 * answers the humorizer is banned from. A deterministic guard
 * ({@link factsPreserved}) checks the result and discards it if any locked
 * token moved, so a sloppy rewrite can never reach the user.
 */

/** Is the standalone slang pass configured? Needs the flag and an OpenAI key. */
export function isSlangPassEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.ENABLE_SLANG && !!cfg.OPENAI_API_KEY;
}

const SLANG_SYSTEM_PROMPT = `You are a vocabulary localizer for a Telegram bot's replies. The bot answers in neutral Russian; your job is to make the SAME answer sound like it was written by a member of this particular group chat, by using the group's own slang words.

This is a WORD-LEVEL pass, not a rewrite and NOT a joke pass:
- Swap ordinary words for the chat's slang from the list below WHERE ONE GENUINELY FITS the meaning. That is the whole job.
- You may lightly adjust the surrounding wording so the substitution reads naturally (agreement, word order inside the phrase, a casual connector).
- Do NOT add jokes, riffs, laughing, greetings, sign-offs, emoji or commentary. Do NOT re-order or merge sentences. Do NOT change the tone from informative to comedic.
- If nothing on the list fits the text, return the input COMPLETELY UNCHANGED. That is a correct, expected outcome — forcing a word in is worse than leaving the text alone.

HARD rules (breaking one ruins the answer — it is often exact, factual data):
- Every FACT stays character-for-character: numbers, amounts, prices, percentages, dates, times, names, @usernames, URLs/links, code and any identifiers. Never re-state a number in words, never round, never convert.
- Never add, drop or reorder information. Every item on a list stays, in the same order.
- Preserve the structure exactly: line breaks, bullets, numbering, headings, Markdown/HTML formatting.
- Keep the SAME language as the input (Russian or English).
- Output ONLY the resulting text — no quotes, no preamble, no notes about what you changed.

Example (slang «катка» = игра, «изи» = легко):
  IN:  Игра начнётся в 20:00, победа будет лёгкой.
  OUT: Катка начнётся в 20:00, победа будет изи.`;

/**
 * Build the slang-pass system prompt for a chat. The lexicon is the point of
 * this pass, so an empty list is a programming error at the call site — callers
 * must skip the pass entirely (see {@link classifySlangDecision}); we still
 * degrade gracefully and return the base prompt.
 */
export function buildSlangSystemPrompt(lexicon: HumorLexiconTerm[]): string {
  const terms = lexicon.filter((t) => t.term.trim());
  if (terms.length === 0) return SLANG_SYSTEM_PROMPT;
  const lines = terms.map(({ term, gloss }) =>
    gloss && gloss.trim() ? `- «${term}» — ${gloss.trim()}` : `- «${term}»`,
  );
  return (
    SLANG_SYSTEM_PROMPT +
    `\n\nChat lexicon — the slang and distorted word-forms THIS group actually uses. ` +
    `Use only these; do not invent slang of your own:\n` +
    lines.join('\n')
  );
}

/**
 * Why a reply did or didn't get the slang pass. Mirrors `classifyHumorDecision`
 * so both gates are diagnosable from one log line each.
 */
export type SlangDecision =
  | 'sent'
  | 'humorized'
  | 'already-toned'
  | 'slang-disabled'
  | 'no-lexicon';

/**
 * Pure classifier for the slang gate. Order matters — it reports the FIRST
 * reason that applies:
 *   1. the humorizer ran     → 'humorized'      (slang already rode along there)
 *   2. producer self-toned   → 'already-toned'  (e.g. the spending digest)
 *   3. slang off             → 'slang-disabled' (flag/key/per-chat/tutor)
 *   4. nothing learned yet   → 'no-lexicon'     (skip the network call)
 *   otherwise                → 'sent'
 */
export function classifySlangDecision(opts: {
  enabled: boolean;
  humorized: boolean;
  toned: boolean;
  lexiconSize: number;
}): SlangDecision {
  if (opts.humorized) return 'humorized';
  if (opts.toned) return 'already-toned';
  if (!opts.enabled) return 'slang-disabled';
  if (opts.lexiconSize <= 0) return 'no-lexicon';
  return 'sent';
}

/** Numbers (2, 3.5, 1 000), @usernames and URLs — the tokens that carry facts. */
const URL_RE = /https?:\/\/\S+/gi;
const HANDLE_RE = /@[A-Za-z0-9_]{2,}/g;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

function lockedTokens(text: string): string[] {
  const urls = text.match(URL_RE) ?? [];
  // Strip URLs before looking for numbers/handles: a link's own digits and any
  // "@" inside it belong to the URL token, not to the prose.
  const prose = text.replace(URL_RE, ' ');
  const handles = prose.match(HANDLE_RE) ?? [];
  const numbers = (prose.match(NUMBER_RE) ?? []).map((n) => n.replace(',', '.'));
  return [...urls, ...handles, ...numbers].sort();
}

/**
 * Deterministic safety net for the slang pass: every number, @username and URL
 * in the original must still be present in the rewrite, the same number of
 * times, with nothing invented on top. The pass touches exact answers (prices,
 * cooldowns, forecasts, balances), so "the model probably behaved" is not good
 * enough — a mismatch means we throw the rewrite away and ship the original.
 *
 * Pure and order-insensitive (the prompt forbids re-ordering, but a swapped
 * pair of numbers inside one sentence is a wording change, not a fact change).
 */
export function factsPreserved(original: string, rewritten: string): boolean {
  const before = lockedTokens(original);
  const after = lockedTokens(rewritten);
  if (before.length !== after.length) return false;
  return before.every((tok, i) => tok === after[i]);
}

/**
 * Run the slang pass over `text` via OpenAI (plain `fetch`, mirroring the
 * humorizer). Throws when unconfigured or the request fails — callers wanting a
 * safe fallback use {@link applySlangOrOriginal}.
 */
export async function applySlang(
  text: string,
  lexicon: HumorLexiconTerm[],
): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) {
    throw new Error('slang pass not configured (OPENAI_API_KEY unset)');
  }

  const terms = lexicon.filter((t) => t.term.trim());
  if (terms.length > 0) {
    logger.info(
      {
        count: terms.length,
        slang: terms.map((t) =>
          t.gloss && t.gloss.trim() ? `${t.term} — ${t.gloss.trim()}` : t.term,
        ),
      },
      'slang pass → openai',
    );
  }

  const res = await fetch(`${cfg.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
    },
    // Same minimal payload + shared reasoning/timeout knobs as the humorizer:
    // this is an even cheaper task, and it sits in front of factual answers, so
    // it must never be the slow part of a reply.
    body: JSON.stringify({
      model: cfg.OPENAI_HUMOR_MODEL,
      ...reasoningField(),
      messages: [
        { role: 'system', content: buildSlangSystemPrompt(terms) },
        { role: 'user', content: text },
      ],
    }),
    signal: humorTimeoutSignal(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`slang pass failed: ${res.status} ${detail}`.trim());
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) {
    throw new Error('slang pass returned empty content');
  }
  return out;
}

/**
 * Best-effort slang pass: returns the text in the chat's lingo, or the original
 * unchanged when the pass is off, the lexicon is empty, the call fails, or the
 * rewrite failed the {@link factsPreserved} guard. Never throws — an exact
 * answer must ship even when the tone pass misbehaves.
 */
export async function applySlangOrOriginal(
  text: string,
  lexicon: HumorLexiconTerm[],
): Promise<string> {
  if (!isSlangPassEnabled()) return text;
  if (lexicon.filter((t) => t.term.trim()).length === 0) return text;
  try {
    const out = await applySlang(text, lexicon);
    if (!factsPreserved(text, out)) {
      logger.warn(
        { original: text, rewritten: out },
        'slang pass altered facts, keeping original',
      );
      return text;
    }
    return out;
  } catch (err) {
    logger.warn({ err }, 'slang pass failed, using original text');
    return text;
  }
}
