import type Anthropic from '@anthropic-ai/sdk';

// Request knobs for the HIDDEN cheap-tier passes (condense, memory/lexicon
// extraction, episodes, profiles, classifier, watch verdicts, reconcile). They
// want the same thing on every model — no thinking (latency + their small
// max_tokens), and output as repeatable as the model allows — but the way to ask
// differs per model, and a wrong knob is a 400 on every call:
//   - Haiku 4.5 and older: thinking is off unless asked; `temperature: 0` works.
//   - Haiku 5.5 / Sonnet 5 / Opus 5: thinking is ON by default, so it is turned
//     off explicitly; any non-default `temperature` is a 400.
//   - Sonnet 5.5 / Opus 5.5 / Fable / Mythos: `disabled` is a 400 and so is
//     temperature — send neither (only someone overriding the model gets here).
// Pure and pinned by a test, so an env override can't silently 400 a pass.

export type HiddenPassParams = {
  temperature?: number;
  thinking?: Anthropic.ThinkingConfigParam;
};

export function hiddenPassParams(model: string): HiddenPassParams {
  const m = model.toLowerCase();
  if (/claude-(3|haiku-4|sonnet-4|opus-4)/.test(m)) return { temperature: 0 };
  if (/claude-(sonnet-5-5|opus-5-5|fable|mythos)/.test(m)) return {};
  return { thinking: { type: 'disabled' } };
}
