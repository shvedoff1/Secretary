import type { Context } from 'grammy';

/**
 * Live "печатает…" (typing) indicator. Telegram clears a chat action on its own
 * after ~5 seconds, so for a generation that takes longer we re-send it on an
 * interval until stopped. Entirely best-effort: a failed action (rights, network)
 * never blocks or breaks the actual reply.
 */
const TYPING_REFRESH_MS = 4500;

export interface TypingHandle {
  stop(): void;
}

/**
 * Start showing "печатает…" in the chat and keep it alive until `.stop()` is
 * called. Send the first action immediately so the indicator appears the moment
 * the bot decides to answer, then refresh it every few seconds while it works.
 */
export function startTyping(ctx: Context): TypingHandle {
  let stopped = false;
  const send = (): void => {
    if (stopped) return;
    // replyWithChatAction targets the current chat (and forum topic) from ctx.
    void ctx.replyWithChatAction('typing').catch(() => {
      /* chat actions are best-effort */
    });
  };
  send();
  const timer = setInterval(send, TYPING_REFRESH_MS);
  // A typing indicator must never keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
