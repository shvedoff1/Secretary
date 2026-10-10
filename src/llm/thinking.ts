import type Anthropic from '@anthropic-ai/sdk';

// The `thinking` field of the main assistant call, per model.
//
// The secretary wants thinking OFF on tool-routing turns: adaptive thinking adds
// latency to every turn and spends from the 2048-token max_tokens budget, which
// risks truncated answers / tool-call JSON. HOW to say "off" depends on the model:
//   - Sonnet 5 and older: `{type: 'disabled'}`.
//   - Sonnet 5.5: `disabled` is a 400; the off-switch is `{type: 'between_tools'}`
//     (no other field allowed, effort `high` or below — the default).
//   - Opus 5.5 / Fable / Mythos: thinking can't be turned off at all (`disabled`
//     is a 400) — omit the field and let it run adaptive.
// Tutor mode is the opposite trade (accuracy over latency): adaptive everywhere.
//
// A wrong value here is not a degraded answer but a 400 on EVERY turn, so the
// mapping is pure and pinned by a test.

/** SDK 0.105 predates `between_tools`, so the union is widened locally. */
export type ThinkingParam = Anthropic.ThinkingConfigParam | { type: 'between_tools' };

export function thinkingFor(model: string, opts: { tutor: boolean }): ThinkingParam | undefined {
  if (opts.tutor) return { type: 'adaptive' };
  const m = model.toLowerCase();
  if (/claude-sonnet-5-5/.test(m)) return { type: 'between_tools' };
  if (/claude-(opus-5-5|fable|mythos)/.test(m)) return undefined;
  return { type: 'disabled' };
}
