import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';
import { startTyping } from '../src/bot/flows/typing.js';

function ctx(): { ctx: Context; calls: () => number } {
  const replyWithChatAction = vi.fn(() => Promise.resolve(true));
  return {
    ctx: { replyWithChatAction } as unknown as Context,
    calls: () => replyWithChatAction.mock.calls.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startTyping', () => {
  it('sends "typing" immediately so the indicator shows at once', () => {
    const { ctx: c, calls } = ctx();
    const handle = startTyping(c);
    expect(calls()).toBe(1);
    expect(vi.mocked(c.replyWithChatAction)).toHaveBeenCalledWith('typing');
    handle.stop();
  });

  it('refreshes the action on an interval while running', () => {
    const { ctx: c, calls } = ctx();
    const handle = startTyping(c);
    vi.advanceTimersByTime(4500 * 2 + 10);
    expect(calls()).toBe(3); // immediate + two refreshes
    handle.stop();
  });

  it('stops refreshing once stopped', () => {
    const { ctx: c, calls } = ctx();
    const handle = startTyping(c);
    handle.stop();
    vi.advanceTimersByTime(4500 * 5);
    expect(calls()).toBe(1); // only the immediate send happened
  });

  it('never throws when sending the action fails', () => {
    const replyWithChatAction = vi.fn(() => Promise.reject(new Error('no rights')));
    const c = { replyWithChatAction } as unknown as Context;
    expect(() => startTyping(c).stop()).not.toThrow();
  });
});
