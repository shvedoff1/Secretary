import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * Is the humorizer pass configured? It needs both the feature flag and an
 * OpenAI key (the same key used for voice transcription).
 */
export function isHumorEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.ENABLE_HUMOR && !!cfg.OPENAI_API_KEY;
}

// Heavy rewrite with a loud persona, but the FACTS stay locked. The prompt
// gives wide latitude to restructure/riff (the timid touch-up wasn't landing)
// while still forbidding any change to numbers, names, links or the language.
const HUMOR_SYSTEM_PROMPT = `You are the voice of a Telegram bot, cranked all the way up. Rewrite the bot's reply IN CHARACTER: a permanently chilled-out, slightly stoned surfer bro who finds everything hilarious, cackles at random nonsense, and talks in loose slang. Go big on the REWORDING — restructure sentences, riff, crack a dumb joke or a goofy little rhyme, react with laughter. Make it genuinely funny and clearly DIFFERENT from the input, not a shy touch-up.

Character & voice:
- Stoned-surfer energy: laid-back, easily amused, laughs at nothing ("ахаха", "хех", "лол"; EN: "haha", "lmao").
- Sprinkle filler/slang naturally: "йоу", "братуха", "бро", "чел", "короче", "ну такое", "изи", "вайб" (EN: "yo", "bro", "dude", "man", "like"). Don't cram in every one — keep it readable.
- Toss in the odd dumb rhyme or bit of wordplay for the fun of it.
- Light emoji welcome (🤙🌊😂), don't spam them.

Keep it real (HARD rules — the bit must NOT break them):
- Every FACT stays EXACTLY: numbers, amounts, dates, times, names, @usernames, URLs/links and any code — character-for-character. Never invent "jokey" facts or data, and never drop info that mattered.
- Keep the SAME language as the input (Russian or English).
- Preserve Markdown/links/formatting.
- Output ONLY the rewritten reply — no quotes, no preamble, no notes about what you changed.

Length: keep it punchy. You can stretch a little for the joke, but don't turn a one-liner into an essay.`;

/** A slang/distorted word this chat uses, as fed to the humorizer. */
export interface HumorLexiconTerm {
  term: string;
  gloss?: string;
}

/**
 * Build the humorizer system prompt, optionally appending the chat's learned
 * slang so the rewrite speaks in the group's own lingo. This is the ONLY place
 * the lexicon reaches a model now — Claude sees clean history/context, and the
 * OpenAI tone-pass is where the chat's voice gets applied. Empty/absent lexicon
 * → the plain prompt unchanged, so nothing shows up for a fresh chat.
 */
export function buildHumorSystemPrompt(lexicon?: HumorLexiconTerm[]): string {
  const terms = (lexicon ?? []).filter((t) => t.term.trim());
  if (terms.length === 0) return HUMOR_SYSTEM_PROMPT;
  const lines = terms.map(({ term, gloss }) =>
    gloss && gloss.trim() ? `- «${term}» — ${gloss}` : `- «${term}»`,
  );
  return (
    HUMOR_SYSTEM_PROMPT +
    `\n\nChat lexicon — slang and distorted word-forms THIS group actually uses. ` +
    `Weave them in naturally where they fit (don't cram in every one), so the bit ` +
    `sounds like one of the crew. Still obey every HARD rule above — the lexicon ` +
    `changes only the VOICE, never a fact:\n` +
    lines.join('\n')
  );
}

/**
 * Why a plain-chat reply was or wasn't handed to the humorizer (OpenAI). Logged
 * at the decision point so "почему не поехало в openai" is observable instead of
 * guessed: `sent` = went to OpenAI; the rest are the three skip reasons.
 */
export type HumorDecision = 'sent' | 'humor-disabled' | 'tool-answer' | 'money-context';

/**
 * Pure classifier for the humorizer gate. Order matters — it reports the FIRST
 * reason that applies, mirroring the runtime short-circuit:
 *   1. humour off (flag/key)         → 'humor-disabled'
 *   2. a tool produced the answer    → 'tool-answer'   (facts must stay verbatim)
 *   3. the turn is money-context     → 'money-context' (amounts must stay verbatim)
 *   otherwise                        → 'sent'
 */
export function classifyHumorDecision(opts: {
  enabled: boolean;
  humorizable: boolean;
  money: boolean;
}): HumorDecision {
  if (!opts.enabled) return 'humor-disabled';
  if (!opts.humorizable) return 'tool-answer';
  if (opts.money) return 'money-context';
  return 'sent';
}

/**
 * Rewrite an assistant reply in a funnier tone via OpenAI's chat-completions
 * API. Mirrors the transcription module: a plain `fetch` (no SDK) against the
 * configurable OpenAI base URL. Throws if not configured or the request fails —
 * callers that want a safe fallback should use {@link humorizeOrOriginal}.
 */
export async function humorize(text: string, lexicon?: HumorLexiconTerm[]): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) {
    throw new Error('humor not configured (OPENAI_API_KEY unset)');
  }

  const res = await fetch(`${cfg.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
    },
    // Keep the payload minimal (model + messages) so it stays compatible across
    // OpenAI model families — newer "mini" models reject custom temperature.
    body: JSON.stringify({
      model: cfg.OPENAI_HUMOR_MODEL,
      messages: [
        { role: 'system', content: buildHumorSystemPrompt(lexicon) },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`humorize failed: ${res.status} ${detail}`.trim());
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) {
    throw new Error('humorize returned empty content');
  }
  return out;
}

/**
 * Best-effort humorizer: returns a funnier version of `text`, or the original
 * text unchanged when the feature is disabled or anything goes wrong. The
 * humour pass must never block or break a reply, so failures are swallowed.
 */
export async function humorizeOrOriginal(
  text: string,
  lexicon?: HumorLexiconTerm[],
): Promise<string> {
  if (!isHumorEnabled()) return text;
  try {
    return await humorize(text, lexicon);
  } catch (err) {
    logger.warn({ err }, 'humorize failed, using original text');
    return text;
  }
}

/**
 * Like {@link humorizeOrOriginal}, but when the humorizer is active it first
 * hands the pre-OpenAI original to `sendOriginal` (used to DM the admin the
 * "before" text for side-by-side comparison). The preview is best-effort and
 * never blocks or breaks the reply; when humour is disabled nothing is sent.
 */
export async function humorizeWithPreview(
  text: string,
  sendOriginal: (original: string) => Promise<void>,
  lexicon?: HumorLexiconTerm[],
): Promise<string> {
  if (!isHumorEnabled()) return text;
  try {
    await sendOriginal(text);
  } catch (err) {
    logger.warn({ err }, 'failed to send humor preview');
  }
  return humorizeOrOriginal(text, lexicon);
}
