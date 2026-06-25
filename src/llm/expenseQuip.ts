import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * Is the expense-quip pass configured? Needs the feature flag and an OpenAI key
 * (the same key used for transcription/humor).
 */
export function isExpenseQuipEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.ENABLE_EXPENSE_QUIP && !!cfg.OPENAI_API_KEY;
}

// A standalone joke that rides ALONGSIDE the expense preview as its own message.
// Crucially it must NOT assert any data: no amounts, currencies, percentages,
// who-paid/who-owes, names — it only riffs on the VIBE of what was bought. Even
// if it slipped, the joke is a separate message and never feeds the recorded
// expense, but we forbid it anyway so it reads as obviously-a-joke.
const QUIP_SYSTEM_PROMPT = `You are the comic sidekick of a Telegram expense bot. The bot just logged an expense and shows it in a separate message with the real numbers. Your ONLY job: fire back ONE short, punchy joke (1-2 sentences max) riffing on WHAT was bought — a chilled-out, slightly stoned surfer-bro vibe, loose slang, easily amused.

HARD rules:
- Output ONLY the joke text. No preamble, no quotes, no explanation.
- Do NOT state or invent any amounts, sums, currencies, prices, percentages, who paid, who owes, or anyone's name. The real data lives in the other message — yours is pure comedy about the THING bought, not the figures.
- Keep it to 1-2 short sentences. Punchy, not an essay.
- Match the language of the input (Russian or English). Default to Russian.
- Light emoji ok (🤙🌊😂), don't spam.`;

/**
 * Best-effort comic riff on a detected expense. Returns a short standalone joke,
 * or null when disabled / on any failure (it must never block or break the
 * expense flow). `summary` is a short description of what was bought (e.g. the
 * expense title(s)) — NOT the amounts.
 */
export async function expenseQuip(summary: string): Promise<string | null> {
  if (!isExpenseQuipEnabled()) return null;
  const trimmed = summary.trim();
  if (!trimmed) return null;

  const cfg = loadConfig();
  try {
    const res = await fetch(`${cfg.OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
      },
      // Minimal payload (model + messages) for cross-model compatibility, mirroring
      // humorize.ts — newer "mini" models reject a custom temperature.
      body: JSON.stringify({
        model: cfg.OPENAI_HUMOR_MODEL,
        messages: [
          { role: 'system', content: QUIP_SYSTEM_PROMPT },
          { role: 'user', content: `Куплено: ${trimmed}` },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`expense quip failed: ${res.status} ${detail}`.trim());
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const out = data.choices?.[0]?.message?.content?.trim();
    return out || null;
  } catch (err) {
    logger.warn({ err }, 'expense quip failed, skipping');
    return null;
  }
}
