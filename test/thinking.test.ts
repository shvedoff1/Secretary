import { describe, it, expect } from 'vitest';
import { thinkingFor } from '../src/llm/thinking.js';

// The off-switch for thinking is model-specific, and a wrong one is a 400 on
// every assistant turn — so the mapping is pinned here.
describe('thinkingFor', () => {
  it('uses between_tools on Sonnet 5.5, where `disabled` is rejected', () => {
    expect(thinkingFor('claude-sonnet-5-5', { tutor: false })).toEqual({ type: 'between_tools' });
  });

  it('keeps `disabled` on Sonnet 5 and older models', () => {
    expect(thinkingFor('claude-sonnet-5', { tutor: false })).toEqual({ type: 'disabled' });
    expect(thinkingFor('claude-sonnet-4-6', { tutor: false })).toEqual({ type: 'disabled' });
    expect(thinkingFor('claude-opus-4-8', { tutor: false })).toEqual({ type: 'disabled' });
  });

  it('omits the field where thinking cannot be turned off', () => {
    expect(thinkingFor('claude-opus-5-5', { tutor: false })).toBeUndefined();
    expect(thinkingFor('claude-fable-5-1', { tutor: false })).toBeUndefined();
  });

  it('lets the tutor think on every model', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5']) {
      expect(thinkingFor(m, { tutor: true })).toEqual({ type: 'adaptive' });
    }
  });
});
