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

// Strict, tone-only rewrite. The whole point is to add humour WITHOUT touching
// any fact Anthropic produced — so the prompt forbids changing numbers, names,
// links and the language, and demands a bare reply with no preamble.
const HUMOR_SYSTEM_PROMPT = `You are a comedic editor for a Telegram assistant bot. You receive the bot's reply and rewrite it to be funnier, wittier and more playful — like a quick-witted, chill mate in a group chat.

HARD RULES (breaking any of these is a failure):
- Preserve every fact EXACTLY: numbers, amounts, dates, times, names, @usernames, URLs/links and any code must stay identical.
- Do NOT add new facts, claims or information, and do NOT drop any. Only change wording and tone.
- Keep the SAME language as the input (Russian or English).
- Keep it short — about the same length or shorter. No walls of text, no lectures.
- Preserve Markdown/formatting; light emoji are fine, don't spam them.
- Output ONLY the rewritten reply — no quotes, no preamble, no notes about what you changed.`;

/**
 * Rewrite an assistant reply in a funnier tone via OpenAI's chat-completions
 * API. Mirrors the transcription module: a plain `fetch` (no SDK) against the
 * configurable OpenAI base URL. Throws if not configured or the request fails —
 * callers that want a safe fallback should use {@link humorizeOrOriginal}.
 */
export async function humorize(text: string): Promise<string> {
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
        { role: 'system', content: HUMOR_SYSTEM_PROMPT },
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
export async function humorizeOrOriginal(text: string): Promise<string> {
  if (!isHumorEnabled()) return text;
  try {
    return await humorize(text);
  } catch (err) {
    logger.warn({ err }, 'humorize failed, using original text');
    return text;
  }
}
