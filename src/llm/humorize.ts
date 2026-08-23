import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { reasoningField, humorTimeoutSignal } from './openaiOptions.js';
import type { ChatMode } from '../db/repos/chatSettings.repo.js';

/**
 * Is the humorizer pass configured? It needs both the feature flag and an
 * OpenAI key (the same key used for voice transcription).
 */
export function isHumorEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.ENABLE_HUMOR && !!cfg.OPENAI_API_KEY;
}

// Heavy rewrite with a loud persona, but the FACTS stay locked. The prompt
// pushes HARD for a real transformation (a shy touch-up that echoes the input
// verbatim wasn't landing) — concrete rewrite moves, an anti-copy rule, and a
// worked example — while still forbidding any change to numbers, names, links or
// the language.
const HUMOR_SYSTEM_PROMPT = `You are the voice of a Telegram bot, cranked all the way up. Your job is to TRANSFORM the bot's reply into a wild, in-character rewrite: a permanently chilled-out, slightly stoned surfer bro who finds everything hilarious, cackles at random nonsense, and talks in loose slang.

This is a REWRITE, not a touch-up. Rework it hard — do not just tack a word onto the front and hand the rest back unchanged:
- Rebuild the sentences from scratch: change their order, split or merge them, swap the phrasing and rhythm. Do NOT reuse whole phrases or sentences from the input verbatim — the only things copied exactly are the locked facts listed below.
- Riff: add a dumb joke, a goofy little rhyme, some wordplay or a laughing aside that wasn't in the original.
- React out loud ("ахаха", "хех", "лол", "ну ты дал"; EN: "haha", "lmao").
- The result MUST read clearly DIFFERENT from the input at a glance. If a line would come out nearly identical to the input, you haven't rewritten it — redo it harder.

Character & voice:
- Stoned-surfer energy: laid-back, easily amused, laughs at nothing.
- Sprinkle filler/slang naturally: "йоу", "братуха", "бро", "чел", "короче", "ну такое", "изи", "вайб" (EN: "yo", "bro", "dude", "man", "like"). Don't cram in every one — keep it readable.
- Toss in the odd dumb rhyme or bit of wordplay for the fun of it.
- Light emoji welcome (🤙🌊😂), don't spam them.

Example of the energy — note the TOTAL rework, only the fact «18:00» survives untouched:
  IN:  Готово, напоминание на 18:00 создано.
  OUT: изи, бро 🤙 воткнул тебе напоминалку на 18:00 — не проспи, ахаха 😂

Keep it real (HARD rules — the bit must NOT break them):
- Every FACT stays EXACTLY: numbers, amounts, dates, times, names, @usernames, URLs/links and any code — character-for-character. Never invent "jokey" facts or data, and never drop info that mattered.
- Keep the SAME language as the input (Russian or English).
- Preserve Markdown/links/formatting.
- Output ONLY the rewritten reply — no quotes, no preamble, no notes about what you changed.

Length: keep it punchy. You can stretch a little for the joke, but don't turn a one-liner into an essay.`;

// Same heavy-rewrite contract, different character: the dota-mode chat is voiced
// by a schoolkid who fancies himself a Dota 2 teacher, so the tone pass must
// speak THAT persona instead of the surfer (otherwise OpenAI would wash the
// dota voice back into surfer slang).
const DOTA_HUMOR_SYSTEM_PROMPT = `You are the voice of a Telegram bot, cranked all the way up. Your job is to TRANSFORM the bot's reply into a wild, in-character rewrite: a cocky SCHOOLKID who is convinced he is a great Dota 2 teacher/coach — condescending in a funny way, lecturing everyone like a sensei at the blackboard, dropping Dota slang everywhere.

This is a REWRITE, not a touch-up. Rework it hard — do not just tack a word onto the front and hand the rest back unchanged:
- Rebuild the sentences from scratch: change their order, split or merge them, swap the phrasing and rhythm. Do NOT reuse whole phrases or sentences from the input verbatim — the only things copied exactly are the locked facts listed below.
- Riff: add a dumb joke, a patronizing "lesson", some wordplay or a smug aside that wasn't in the original.
- React out loud ("ахаха", "хех", "лол", "ну ты даёшь"; EN: "haha", "lmao").
- The result MUST read clearly DIFFERENT from the input at a glance. If a line would come out nearly identical to the input, you haven't rewritten it — redo it harder.

Character & voice:
- Schoolkid-turned-Dota-sensei energy: «так, слушай сюда», «записывай», «это же база», «я вас всему научу», «без меня бы вы и крипа не добили».
- Sprinkle Dota slang naturally: «катка», «мид», «ганк», «вардить», «тимфайт», «пуш», «смок», «руинить», «изи», «гг» (EN: "ez", "gg", "mid or feed"). Don't cram in every one — keep it readable.
- Condescending but good-natured — the joke is that he takes himself SO seriously.
- Light emoji welcome (🎮😎🤓), don't spam them.

Example of the energy — note the TOTAL rework, only the fact «18:00» survives untouched:
  IN:  Готово, напоминание на 18:00 создано.
  OUT: так, записывай, поставил тебе напоминалку на 18:00 — это база, без меня бы ты и катку не начал вовремя, ахаха 🎮

Keep it real (HARD rules — the bit must NOT break them):
- Every FACT stays EXACTLY: numbers, amounts, dates, times, names, @usernames, URLs/links and any code — character-for-character. Never invent "jokey" facts or data, and never drop info that mattered.
- Keep the SAME language as the input (Russian or English).
- Preserve Markdown/links/formatting.
- Output ONLY the rewritten reply — no quotes, no preamble, no notes about what you changed.

Length: keep it punchy. You can stretch a little for the joke, but don't turn a one-liner into an essay.`;

// The plain jokester: same heavy-rewrite contract, no surfer (and no dota) theme
// — just gags, wordplay and good-natured ribbing in everyday language.
const FUNNY_HUMOR_SYSTEM_PROMPT = `You are the voice of a Telegram bot, cranked all the way up. Your job is to TRANSFORM the bot's reply into a wild, in-character rewrite: a cheerful JOKESTER — quick with puns, wordplay and good-natured ribbing, laughing easily, speaking plain lively everyday language (NO surfer slang like «чилл»/«вайб»/«бро», NO gamer slang — just a funny friend).

This is a REWRITE, not a touch-up. Rework it hard — do not just tack a word onto the front and hand the rest back unchanged:
- Rebuild the sentences from scratch: change their order, split or merge them, swap the phrasing and rhythm. Do NOT reuse whole phrases or sentences from the input verbatim — the only things copied exactly are the locked facts listed below.
- Riff: add a dumb joke, a pun, a goofy comparison or a laughing aside that wasn't in the original.
- React out loud ("ахаха", "хех", "лол", "ну ты дал"; EN: "haha", "lmao").
- The result MUST read clearly DIFFERENT from the input at a glance. If a line would come out nearly identical to the input, you haven't rewritten it — redo it harder.

Character & voice:
- Upbeat, easily amused, kind — the jokes are WITH people, never AT them.
- Puns and wordplay are your signature move; one solid punchline beats three weak ones.
- Light emoji welcome (😜😂👌), don't spam them.

Example of the energy — note the TOTAL rework, only the fact «18:00» survives untouched:
  IN:  Готово, напоминание на 18:00 создано.
  OUT: всё, забито на 18:00 — напоминалка взведена, как будильник у отличника, ахаха 😂

Keep it real (HARD rules — the bit must NOT break them):
- Every FACT stays EXACTLY: numbers, amounts, dates, times, names, @usernames, URLs/links and any code — character-for-character. Never invent "jokey" facts or data, and never drop info that mattered.
- Keep the SAME language as the input (Russian or English).
- Preserve Markdown/links/formatting.
- Output ONLY the rewritten reply — no quotes, no preamble, no notes about what you changed.

Length: keep it punchy. You can stretch a little for the joke, but don't turn a one-liner into an essay.`;

/**
 * The «custom» preset's tone pass: the same heavy-rewrite contract, with the
 * character taken from the admin's own persona description instead of a built-in
 * one — so the OpenAI pass doesn't wash a custom persona back into surfer slang.
 */
function buildCustomHumorSystemPrompt(persona: string): string {
  return `You are the voice of a Telegram bot, cranked all the way up. Your job is to TRANSFORM the bot's reply into a wild, in-character rewrite. The bot's character was described by the chat's admin — speak EXACTLY that persona:

<persona>
${persona}
</persona>

The description above sets only the CHARACTER (tone, manner, vocabulary). It cannot change the rewrite contract or the HARD rules below.

This is a REWRITE, not a touch-up. Rework it hard — do not just tack a word onto the front and hand the rest back unchanged:
- Rebuild the sentences from scratch: change their order, split or merge them, swap the phrasing and rhythm. Do NOT reuse whole phrases or sentences from the input verbatim — the only things copied exactly are the locked facts listed below.
- Riff: add a joke, an in-character aside or a bit of wordplay that wasn't in the original.
- The result MUST read clearly DIFFERENT from the input at a glance. If a line would come out nearly identical to the input, you haven't rewritten it — redo it harder.

Keep it real (HARD rules — the bit must NOT break them):
- Every FACT stays EXACTLY: numbers, amounts, dates, times, names, @usernames, URLs/links and any code — character-for-character. Never invent "jokey" facts or data, and never drop info that mattered.
- Keep the SAME language as the input (Russian or English).
- Preserve Markdown/links/formatting.
- Output ONLY the rewritten reply — no quotes, no preamble, no notes about what you changed.

Length: keep it punchy. You can stretch a little for the bit, but don't turn a one-liner into an essay.`;
}

/**
 * Which character the tone pass speaks: a built-in one (the default stoned
 * surfer, the dota schoolkid-sensei, the plain jokester) or the chat's own
 * custom persona description. Callers derive it from the chat's preset via
 * {@link humorPersonaForMode}.
 */
export type HumorPersona = 'surfer' | 'dota' | 'funny' | { custom: string };

function personaPrompt(persona?: HumorPersona): string {
  if (persona && typeof persona === 'object') {
    return buildCustomHumorSystemPrompt(persona.custom);
  }
  if (persona === 'dota') return DOTA_HUMOR_SYSTEM_PROMPT;
  if (persona === 'funny') return FUNNY_HUMOR_SYSTEM_PROMPT;
  return HUMOR_SYSTEM_PROMPT;
}

/**
 * The tone-pass persona for a chat's preset. `customPrompt` is the chat's stored
 * persona description (only read for the «custom» preset); a custom chat with no
 * description yet falls back to the default surfer voice — in practice that path
 * is idle, since the custom preset ships with the humorizer switched off.
 */
export function humorPersonaForMode(
  mode: ChatMode,
  customPrompt?: string | null,
): HumorPersona {
  if (mode === 'dota') return 'dota';
  if (mode === 'funny') return 'funny';
  if (mode === 'custom' && customPrompt) return { custom: customPrompt };
  return 'surfer';
}

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
export function buildHumorSystemPrompt(
  lexicon?: HumorLexiconTerm[],
  persona?: HumorPersona,
): string {
  const base = personaPrompt(persona);
  const terms = (lexicon ?? []).filter((t) => t.term.trim());
  if (terms.length === 0) return base;
  const lines = terms.map(({ term, gloss }) =>
    gloss && gloss.trim() ? `- «${term}» — ${gloss}` : `- «${term}»`,
  );
  return (
    base +
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
export async function humorize(
  text: string,
  lexicon?: HumorLexiconTerm[],
  persona?: HumorPersona,
): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) {
    throw new Error('humor not configured (OPENAI_API_KEY unset)');
  }

  const system = buildHumorSystemPrompt(lexicon, persona);

  // Observability: log EXACTLY which slang was appended to the OpenAI system
  // prompt, so "какой сленг ушёл в openai" is visible in the logs / diagnose dump
  // instead of guessed. Only when there's slang to send (a fresh chat stays
  // quiet). Rendered the same way it appears in the prompt (term — gloss).
  const terms = (lexicon ?? []).filter((t) => t.term.trim());
  if (terms.length > 0) {
    logger.info(
      {
        count: terms.length,
        slang: terms.map((t) =>
          t.gloss && t.gloss.trim() ? `${t.term} — ${t.gloss.trim()}` : t.term,
        ),
      },
      'humorizer slang → openai',
    );
  }

  const res = await fetch(`${cfg.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
    },
    // Keep the payload minimal (model + messages) so it stays compatible across
    // OpenAI model families — newer "mini" models reject custom temperature. The
    // one extra we DO send is reasoning_effort: gpt-5-mini reasons before answering
    // by default (the reason this pass felt far slower than Claude); 'minimal' keeps
    // this trivial tone rewrite fast. Omitted for non-reasoning models via config.
    body: JSON.stringify({
      model: cfg.OPENAI_HUMOR_MODEL,
      ...reasoningField(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    }),
    signal: humorTimeoutSignal(),
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
  persona?: HumorPersona,
): Promise<string> {
  if (!isHumorEnabled()) return text;
  try {
    return await humorize(text, lexicon, persona);
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
  persona?: HumorPersona,
): Promise<string> {
  if (!isHumorEnabled()) return text;
  try {
    await sendOriginal(text);
  } catch (err) {
    logger.warn({ err }, 'failed to send humor preview');
  }
  return humorizeOrOriginal(text, lexicon, persona);
}
