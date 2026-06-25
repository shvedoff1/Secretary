import { describe, it, expect } from 'vitest';
import { setTranscript, getTranscript } from '../src/bot/transcriptCache.js';

describe('transcriptCache', () => {
  it('stores and retrieves a transcript by chat + message id', () => {
    setTranscript(1, 100, 'Иван проспонсировал поход. 2000 IDR');
    expect(getTranscript(1, 100)).toBe('Иван проспонсировал поход. 2000 IDR');
    // Scoped by chat AND message id.
    expect(getTranscript(2, 100)).toBeUndefined();
    expect(getTranscript(1, 101)).toBeUndefined();
  });

  it('caps the cache, evicting oldest-first', () => {
    // A distinct chat id keeps these keys clear of the test above.
    for (let i = 0; i < 1010; i++) setTranscript(7, i, `t${i}`);
    expect(getTranscript(7, 0)).toBeUndefined(); // evicted
    expect(getTranscript(7, 1009)).toBe('t1009'); // newest retained
  });
});
