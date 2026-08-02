import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

// The watch verdict is a strict yes/no from a cheap model: given the awaited
// event and a page excerpt, did the event ACTUALLY happen? The prompt leans
// hard on "concrete evidence only" because the classic failure mode is a page
// that merely MENTIONS the target (a «скоро в кино» teaser carries the film
// title long before any sessions go on sale) — that must stay met=false.
const CHECK_SYSTEM = `You verify whether an awaited event is now visible on a web page.
You get the CONDITION (what the user is waiting for) and an EXCERPT of the page:
its visible text plus raw-HTML/JSON fragments around matched keywords (schedule
data often lives only in embedded JSON on JS-rendered pages — read those too).

Judge STRICTLY. Answer met=true ONLY when the excerpt contains CONCRETE evidence
that the event has happened — e.g. for "сеансы фильма появились": actual session
times/buttons for THAT film on THAT page. A mere mention of the target, a "скоро
в кино"/"coming soon" teaser, a date picker, or sessions of OTHER films is NOT
enough. When in doubt => met=false (the page is re-checked later anyway; a false
positive spams the chat and kills the watch).

Output ONLY JSON (no prose, no markdown fences):
{"met": <boolean>, "evidence": <string>}
evidence: when met=true — ONE short line in Russian with the concrete evidence
found (e.g. the session times); when met=false — an empty string.`;

export interface WatchVerdict {
  met: boolean;
  evidence: string;
}

/**
 * Parse the model's verdict defensively: grab the outermost JSON object and
 * validate the fields. Anything malformed yields met=false (fail-safe — the
 * watch just re-checks next cycle) rather than throwing.
 */
export function parseWatchVerdict(text: string): WatchVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { met: false, evidence: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { met: false, evidence: '' };
  }
  if (!parsed || typeof parsed !== 'object') return { met: false, evidence: '' };
  const met = (parsed as { met?: unknown }).met === true;
  const evidence = (parsed as { evidence?: unknown }).evidence;
  return { met, evidence: typeof evidence === 'string' ? evidence.trim() : '' };
}

/**
 * Ask the cheap model whether the awaited event is visible in the page excerpt.
 * Best-effort: any failure (API error, bad output) returns met=false so a broken
 * check can never fire a false notification — the watch simply re-checks later.
 * temperature 0 keeps the verdict stable across identical polls.
 */
export async function checkWatchCondition(
  condition: string,
  excerpt: string,
): Promise<WatchVerdict> {
  const cfg = loadConfig();
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_WATCH_MODEL,
      max_tokens: 512,
      temperature: 0,
      system: CHECK_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `CONDITION (ждём): ${condition}\n\nEXCERPT:\n${excerpt}`,
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return parseWatchVerdict(text);
  } catch (err) {
    logger.warn({ err }, 'watch condition check failed');
    return { met: false, evidence: '' };
  }
}
