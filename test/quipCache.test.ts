import { describe, it, expect, beforeEach } from 'vitest';
import { setQuip, takeQuip, clearQuip } from '../src/bot/quipCache.js';

describe('quipCache', () => {
  beforeEach(() => {
    // Clear any keys a prior test left behind (module state is process-global).
    for (let i = 0; i < 600; i++) clearQuip(`k${i}`);
    clearQuip('p1');
    clearQuip('p2');
  });

  it('stores and takes a quip once (take removes it)', () => {
    setQuip('p1', 'ну ты и шопоголик 🤙');
    expect(takeQuip('p1')).toBe('ну ты и шопоголик 🤙');
    // Second take finds nothing — a quip is used exactly once.
    expect(takeQuip('p1')).toBeUndefined();
  });

  it('returns undefined for an unknown / cleared pending', () => {
    expect(takeQuip('missing')).toBeUndefined();
    setQuip('p2', 'joke');
    clearQuip('p2');
    expect(takeQuip('p2')).toBeUndefined();
  });

  it('caps the cache, evicting oldest-first', () => {
    // Fill past the cap; the earliest keys should be evicted.
    for (let i = 0; i < 520; i++) setQuip(`k${i}`, `j${i}`);
    expect(takeQuip('k0')).toBeUndefined(); // evicted
    expect(takeQuip('k519')).toBe('j519'); // newest retained
  });
});
