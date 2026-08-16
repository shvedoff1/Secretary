// Pure text helpers for the Dota knowledge base.
//
// Valve's datafeed does NOT hand back ready prose: every description is a
// TEMPLATE whose numbers live separately in `special_values`, e.g.
//   "Teleport to a target point up to %blink_range% units away."
//   "–{s:bonus_AbilityCooldown} сек. перезарядки Healing Ward"
// plus `%%` for a literal percent sign and a bit of HTML (<h1>, <br>). Resolving
// that is on us, so it lives here as pure functions — the riskiest logic in the
// feature and the easiest to unit-test against real fixtures.

export interface DotaSpecialValue {
  name: string;
  values_float?: number[];
  is_percentage?: boolean;
  heading_loc?: string;
  values_shard?: number[];
  values_scepter?: number[];
}

/** Trim a float the way the game client shows it: 5 not 5.0, 1.75 not 1.750001. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '?';
  // Rounding to 2dp already drops the trailing zeroes String() would print
  // (1.75, 5 — never 1.750001 or 5.0), so there is nothing left to special-case.
  return String(Math.round(n * 100) / 100);
}

/**
 * Render a per-level value list the way tooltips do: "25/30/35/40", collapsing
 * a list that is the same at every level down to a single number.
 */
export function formatValues(values: readonly number[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  const parts = values.map(formatNumber);
  const first = parts[0] ?? '';
  return parts.every((p) => p === first) ? first : parts.join('/');
}

/**
 * Index special values by name for template lookup. Lookup must be
 * case-INSENSITIVE: descriptions write `%abilityduration%` while the value is
 * named `AbilityDuration`. Talent templates use a `bonus_` prefix that the value
 * itself sometimes lacks (and vice versa), so both spellings are registered.
 */
export function indexSpecialValues(
  specials: readonly DotaSpecialValue[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const sv of specials ?? []) {
    // Some values only exist in their upgraded form (a scepter/shard-only knob
    // ships with an empty values_float), and the description still references
    // them by name — fall back rather than rendering the sentence as unknown.
    const rendered =
      formatValues(sv.values_float) ??
      formatValues(sv.values_scepter) ??
      formatValues(sv.values_shard);
    if (rendered === null || !sv.name) continue;
    const key = sv.name.toLowerCase();
    if (!map.has(key)) map.set(key, rendered);
    const alias = key.startsWith('bonus_') ? key.slice('bonus_'.length) : `bonus_${key}`;
    if (!map.has(alias)) map.set(alias, rendered);
  }
  return map;
}

// %token% (descriptions/notes) and {s:token} / {f:token} / {v:token} (talents,
// facet text). Both name the same special values.
const PERCENT_TOKEN = /%([a-zA-Z0-9_]+)%/g;
const BRACE_TOKEN = /\{[a-z]:([a-zA-Z0-9_]+)\}/g;

/**
 * Substitute a description/talent template with its resolved numbers.
 *
 * An unknown token becomes `?` rather than staying as `%raw_token%`: the card is
 * read by a model, and a leftover template reads as data it should quote. `?`
 * reads as "unknown", which is the truth.
 */
export function resolveTemplate(
  text: string,
  specials?: readonly DotaSpecialValue[] | Map<string, string>,
): string {
  if (!text) return '';
  const values =
    specials instanceof Map ? specials : indexSpecialValues(specials);
  return text
    .replace(BRACE_TOKEN, (_m, name: string) => values.get(name.toLowerCase()) ?? '?')
    .replace(PERCENT_TOKEN, (_m, name: string) => values.get(name.toLowerCase()) ?? '?')
    // Only AFTER the tokens above: "+%resist%%%" is a value followed by a
    // literal percent sign, so the token must be consumed first.
    .replace(/%%/g, '%');
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Flatten the feed's mini-HTML into plain text. Descriptions use <h1> for the
 * "Active: Blink" style heading and <br> for line breaks; everything else is
 * cosmetic markup we don't need.
 */
export function stripHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(h\d|p|div|li)\s*>/gi, '\n')
    .replace(/<\s*li\s*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Resolve a template and flatten its markup in one step (the usual pairing). */
export function renderText(
  text: string,
  specials?: readonly DotaSpecialValue[] | Map<string, string>,
): string {
  return stripHtml(resolveTemplate(text, specials));
}
