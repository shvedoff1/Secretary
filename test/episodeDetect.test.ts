import { describe, it, expect } from 'vitest';
import { segmentEpisodes } from '../src/episodes/detect.js';

// Boundary detection for episodic memory: sessions are cut by silence gaps in the
// log's own timestamps, the active tail stays open, and stretches too small for an
// episode of their own fold forward into the next session.

const MIN = 60_000; // one minute
const QUIET = 45 * MIN;

const opts = (now: number) => ({ now, quietMs: QUIET, minMessages: 4 });

describe('segmentEpisodes', () => {
  it('returns nothing for an empty log', () => {
    expect(segmentEpisodes([], opts(0))).toEqual([]);
  });

  it('keeps an active conversation open', () => {
    const ts = [0, MIN, 2 * MIN, 3 * MIN, 4 * MIN];
    // "now" is right after the last message — the chat may still be talking.
    expect(segmentEpisodes(ts, opts(5 * MIN))).toEqual([]);
  });

  it('closes a session once the chat has gone quiet', () => {
    const ts = [0, MIN, 2 * MIN, 3 * MIN];
    expect(segmentEpisodes(ts, opts(3 * MIN + QUIET))).toEqual([{ start: 0, end: 3 }]);
  });

  it('splits sessions on a silence gap and keeps the fresh tail open', () => {
    const second = 10 * QUIET;
    const ts = [0, MIN, 2 * MIN, 3 * MIN, second, second + MIN, second + 2 * MIN, second + 3 * MIN];
    expect(segmentEpisodes(ts, opts(second + 4 * MIN))).toEqual([{ start: 0, end: 3 }]);
  });

  it('closes both sessions when the tail is quiet too', () => {
    const second = 10 * QUIET;
    const ts = [0, MIN, 2 * MIN, 3 * MIN, second, second + MIN, second + 2 * MIN, second + 3 * MIN];
    expect(segmentEpisodes(ts, opts(second + 3 * MIN + QUIET))).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it('folds a stray message forward into the next session', () => {
    const second = 10 * QUIET;
    // One lone «ок» long before a real conversation: not an episode of its own.
    const ts = [0, second, second + MIN, second + 2 * MIN, second + 3 * MIN];
    expect(segmentEpisodes(ts, opts(second + 3 * MIN + QUIET))).toEqual([
      { start: 0, end: 4 },
    ]);
  });

  it('accumulates consecutive tiny stretches into the following session', () => {
    const g = 10 * QUIET;
    const ts = [0, g, g + MIN, 2 * g, 2 * g + MIN, 2 * g + 2 * MIN, 2 * g + 3 * MIN, 2 * g + 4 * MIN];
    expect(segmentEpisodes(ts, opts(2 * g + 4 * MIN + QUIET))).toEqual([
      { start: 0, end: 7 },
    ]);
  });

  it('leaves a tiny quiet stretch pending when nothing follows it yet', () => {
    // Two messages, long quiet: below minMessages, no next session to join — it
    // waits to become the pre-chatter of whatever conversation comes next.
    expect(segmentEpisodes([0, MIN], opts(MIN + 2 * QUIET))).toEqual([]);
  });

  it('does not fold a tiny closed stretch into the OPEN tail', () => {
    const second = 10 * QUIET;
    // Tiny old stretch, then a fresh active conversation: nothing closes yet.
    const ts = [0, second, second + MIN, second + 2 * MIN, second + 3 * MIN];
    expect(segmentEpisodes(ts, opts(second + 4 * MIN))).toEqual([]);
  });
});
