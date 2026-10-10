import { describe, it, expect } from 'vitest';
import { hiddenPassParams } from '../src/llm/hiddenPass.js';

// The cheap-tier request knobs are model-specific, and a wrong one is a 400 on
// every hidden pass — so the mapping is pinned here.
describe('hiddenPassParams', () => {
  it('Haiku 5.5: thinking explicitly off (it is on by default), no temperature (400)', () => {
    expect(hiddenPassParams('claude-haiku-5-5')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('Haiku 4.5 and older: temperature 0, thinking left unset (off by default)', () => {
    expect(hiddenPassParams('claude-haiku-4-5-20251001')).toEqual({ temperature: 0 });
    expect(hiddenPassParams('claude-sonnet-4-6')).toEqual({ temperature: 0 });
  });

  it('models where thinking cannot be disabled get neither knob', () => {
    expect(hiddenPassParams('claude-sonnet-5-5')).toEqual({});
    expect(hiddenPassParams('claude-opus-5-5')).toEqual({});
  });

  it('Sonnet 5 / Opus 5 accept disabled thinking', () => {
    expect(hiddenPassParams('claude-sonnet-5')).toEqual({ thinking: { type: 'disabled' } });
  });
});
