import { describe, it, expect } from 'vitest';
import { parseWatchVerdict } from '../src/llm/watchCheck.js';

// The verdict parser is the last line of defence between a chatty model and a
// false notification: anything malformed must read as "not met", never throw.

describe('parseWatchVerdict', () => {
  it('parses a clean met=true verdict with evidence', () => {
    const v = parseWatchVerdict('{"met": true, "evidence": "сеансы 19:30 и 21:00"}');
    expect(v).toEqual({ met: true, evidence: 'сеансы 19:30 и 21:00' });
  });

  it('parses met=false with empty evidence', () => {
    expect(parseWatchVerdict('{"met": false, "evidence": ""}')).toEqual({
      met: false,
      evidence: '',
    });
  });

  it('extracts the JSON object out of surrounding prose/fences', () => {
    const v = parseWatchVerdict(
      'Вот вердикт:\n```json\n{"met": true, "evidence": "билеты в продаже"}\n```\nготово',
    );
    expect(v.met).toBe(true);
    expect(v.evidence).toBe('билеты в продаже');
  });

  it('treats a non-boolean met as not met (fail-safe)', () => {
    expect(parseWatchVerdict('{"met": "true", "evidence": "x"}').met).toBe(false);
    expect(parseWatchVerdict('{"met": 1}').met).toBe(false);
  });

  it('returns not-met on garbage, no JSON, or broken JSON', () => {
    expect(parseWatchVerdict('нет тут ничего')).toEqual({ met: false, evidence: '' });
    expect(parseWatchVerdict('{"met": true')).toEqual({ met: false, evidence: '' });
    expect(parseWatchVerdict('')).toEqual({ met: false, evidence: '' });
  });

  it('drops a non-string evidence field', () => {
    expect(parseWatchVerdict('{"met": true, "evidence": 42}')).toEqual({
      met: true,
      evidence: '',
    });
  });
});
