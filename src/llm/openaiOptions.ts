import { loadConfig } from '../config.js';

/**
 * Extra request fields for the humorizer / expense-quip chat-completions calls.
 * The only knob here is `reasoning_effort`: GPT-5-family models reason before
 * answering by default, which makes these trivial tone passes slow — 'minimal'
 * (the config default) essentially skips that. Returns an empty object when the
 * effort is 'none' so the field is omitted entirely for non-reasoning models
 * (e.g. gpt-4o-mini) that reject it. Spread into the JSON body.
 */
export function reasoningField(): Record<string, string> {
  const effort = loadConfig().OPENAI_REASONING_EFFORT;
  return effort === 'none' ? {} : { reasoning_effort: effort };
}

/**
 * An AbortSignal that trips after the configured humorizer / quip timeout, so a
 * slow OpenAI call can't hold a reply hostage. Both callers treat a timeout as a
 * best-effort miss (humorizer falls back to the original, quip is skipped).
 */
export function humorTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(loadConfig().OPENAI_HUMOR_TIMEOUT_MS);
}
