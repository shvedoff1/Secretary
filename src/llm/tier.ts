import type { Config } from '../config.js';

/**
 * Which TIER a model call belongs to. Callers name their model through config
 * (ANTHROPIC_MODEL = the dialogue, the precise/calendar model = the precise tier,
 * every ANTHROPIC_*_MODEL hidden pass = the cheap tier), so a vendor translator
 * reads the tier back off which config value was passed — no call site ever
 * names a vendor. Pure, for tests.
 */
export type ModelTier = 'dialogue' | 'precise' | 'cheap';

export function tierOf(model: string, cfg: Config): ModelTier {
  if (model === cfg.ANTHROPIC_MODEL) return 'dialogue';
  if (model === cfg.ANTHROPIC_PRECISE_MODEL || model === cfg.ANTHROPIC_CALENDAR_MODEL) return 'precise';
  return 'cheap';
}
