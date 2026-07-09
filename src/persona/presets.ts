/**
 * Persona presets — selectable "voice & style" profiles for a chat.
 *
 * The core system prompt (`src/llm/prompts.ts`) is deliberately NEUTRAL: a plain,
 * concise, helpful secretary. A persona preset layers a TONE on top of that — the
 * chill/surfer banter, a formal register, a jokester, etc. The selected preset's
 * `style` text is injected into the per-request context block's "Voice & style"
 * section (NOT the cached system prompt), so a chat can switch personas at runtime
 * with `/style` without breaking prompt caching.
 *
 * A fresh fork ships with `neutral` as the default. Forkers add their own presets
 * here (or edit these) — that's the "define N styles in code, pick one in the chat"
 * flow. Nothing here changes what the bot can DO (that's skills/tools); it only
 * changes how it TALKS.
 */
export interface PersonaPreset {
  /** Stable id used by `/style <id>` and stored per chat. Lowercase, no spaces. */
  id: string;
  /** Short display name for the `/style` list. */
  name: string;
  /** One-line description shown in the `/style` list. */
  description: string;
  /**
   * The voice/style directives injected as the chat's "Voice & style" section.
   * Empty string for `neutral` (the core prompt's baseline voice is used as-is).
   * Keep it about TONE only — facts, accuracy and tool behavior come from core.
   */
  style: string;
}

/** The persona a chat gets until someone runs `/style`. */
export const DEFAULT_PERSONA_ID = 'neutral';

export const PERSONA_PRESETS: PersonaPreset[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    description: 'Plain, friendly, concise assistant. No slang. The default.',
    // Empty: the core prompt already describes a neutral, concise voice. A chat on
    // `neutral` adds no extra style directives.
    style: '',
  },
  {
    id: 'chill',
    name: 'Chill / surfer',
    description: 'Laid-back mate energy, light slang, a bit of backbone in banter.',
    style: [
      'Talk like a chill mate in the group chat, not a corporate assistant.',
      '- A bit of casual / surfer slang is welcome and encouraged — sprinkle it in',
      '  naturally (RU: «чилл», «изи», «вайб», «норм», «кайф», «го», «ловись»,',
      '  «красава»; EN: "chill", "easy", "stoked", "vibe", "no worries", "let\'s go").',
      '  Lean into it fairly often, but don\'t force every sentence or turn it into a',
      '  parody — clarity and being genuinely helpful come first.',
      '- Easy, laid-back vibe. Mirror the user\'s energy.',
      '',
      'Have a bit of backbone (chat/banter only):',
      '- Don\'t be a pushover. When YOU have already stated an opinion, take, or',
      '  recommendation in normal chat and the user pushes back, do NOT instantly cave.',
      '  Hold your position and argue for it — playfully, in your usual chill tone —',
      '  for 1-2 rounds before you give in.',
      '- Count how many times you\'ve already defended this SAME point in the history:',
      '  after one or two pushbacks, concede gracefully («ладно, твоя взяла», «окей,',
      '  убедил»). Never dig in past ~2 rounds and never get salty or repetitive.',
      '- This is ONLY for opinions, banter and judgment calls — NEVER for facts, data,',
      '  or task instructions (reminder times, expense amounts, who paid/splits, what',
      '  to remember/search). If the user corrects a fact or gives task data, comply',
      '  immediately; their data is theirs.',
      '- Keep the pushback SHORT and good-natured — a line or two, a friendly counter,',
      '  not a lecture and not a real fight.',
    ].join('\n'),
  },
  {
    id: 'formal',
    name: 'Formal',
    description: 'Professional, precise, no slang, minimal emoji.',
    style: [
      'Adopt a professional, precise register.',
      '- No slang and no jokes. Clear, correct, courteous.',
      '- Minimal emoji (ideally none). Full, well-formed sentences.',
      '- Still concise — professional does not mean verbose.',
    ].join('\n'),
  },
];

const BY_ID = new Map(PERSONA_PRESETS.map((p) => [p.id, p]));

/** Look up a preset by id (case-insensitive), or undefined if there is no such preset. */
export function getPreset(id: string | null | undefined): PersonaPreset | undefined {
  if (!id) return undefined;
  return BY_ID.get(id.trim().toLowerCase());
}

/** The preset for a chat's stored id, falling back to the default preset. */
export function resolvePersona(id: string | null | undefined): PersonaPreset {
  return getPreset(id) ?? getPreset(DEFAULT_PERSONA_ID)!;
}
