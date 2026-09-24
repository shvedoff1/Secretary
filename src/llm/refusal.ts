/**
 * Refusal guard for the OpenAI tone passes (humorizer + slang). Their input is
 * the MAIN model's reply, which in an adult chat may be a crude joke or a
 * мат-heavy anecdote; a rewrite model with a stricter default can hand back
 * «Извините, я не могу помочь с этим» instead of a rewrite. That is not a tone
 * change, it is the answer being swapped out — so a rewrite that reads as a
 * refusal while the original did not is thrown away and the original ships.
 * Pure and deterministic; deliberately biased to the opening of the text,
 * where a refusal announces itself.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /\b(i['’]?m sorry|sorry),? (but )?i (can(?:no|['’])t|won['’]t|am unable|am not able)/i,
  /\bi (can(?:no|['’])t|won['’]t) (help|assist|comply|do that|rewrite|create|provide|continue)/i,
  /\bi['’]?m (unable|not able) to (help|assist|comply|rewrite|provide|continue)/i,
  /(извин(и|ите)|прост(и|ите)|к сожалению)[,!.\s—-]*(но\s+)?я не (могу|буду|стану)/i,
  /^\s*я не (могу|буду|стану) (помочь|переписать|пересказ|продолж|выполн|с этим|это)/i,
  /не могу (помочь|выполнить|продолжить) (с )?(этим|эту|такой|такую|такое)/i,
];

/** Does `text` read like a refusal? Only the opening ~200 chars are checked. */
export function looksLikeRefusal(text: string): boolean {
  const head = text.slice(0, 200);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

/**
 * True when the tone pass REPLACED the answer with a refusal: the rewrite reads
 * as one and the original did not (a reply that was itself a polite «не могу»
 * may legitimately stay one after the rewrite).
 */
export function rewriteRefused(original: string, rewritten: string): boolean {
  return looksLikeRefusal(rewritten) && !looksLikeRefusal(original);
}
