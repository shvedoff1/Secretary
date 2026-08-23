import type { Api } from 'grammy';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * The forward batch («пересланная пачка»): when someone forwards messages into
 * the chat, the bot does NOT answer each one — it collects them here (text,
 * voice transcripts, photo captions) and marks each with a reaction. The batch
 * is consumed by whichever comes first:
 *
 *  - the user ADDRESSES the bot («сделай саммари», any question) — the batch is
 *    injected into that turn as context (see `runAndRespond`);
 *  - the user TAPS the bot's reaction on any buffered message — the batch is
 *    processed immediately with no typed request (the `message_reaction`
 *    handler in bot.ts), which is also how a single forwarded voice note gets
 *    answered without typing;
 *  - nobody asks for FORWARD_BUFFER_TTL_MINUTES — the batch quietly expires and
 *    the reaction marks are removed.
 *
 * State is in-memory and per chat, like the chime timer: a batch is transient
 * by design (a restart simply drops it), and per-chat ordering is guaranteed by
 * the `sequentialize` middleware, so add/drain never race within one chat.
 */

/** The reaction the bot puts on every buffered message. Deliberately an emoji
 *  nobody drops in casual chatter (👀 is the busy-indicator, ✍ the voice ack),
 *  so a tap on it is an unambiguous "process the pack now" — and tapping the
 *  existing bubble is one touch, no reaction picker needed. */
export const FORWARD_MARK = '🫡' as const;

export interface BufferedForward {
  messageId: number;
  /** Who it was forwarded from (the `forwardOrigin` label). */
  origin: string;
  kind: 'text' | 'voice' | 'photo' | 'document';
  /** Message text / voice transcript / photo caption (may be empty for a photo). */
  text: string;
}

interface BufferState {
  entries: BufferedForward[];
  timer: ReturnType<typeof setTimeout> | null;
  /** How many were dropped over the cap, so the model knows the pack is partial. */
  overflow: number;
}

const buffers = new Map<number, BufferState>();

export function isForwardBufferEnabled(): boolean {
  return loadConfig().ENABLE_FORWARD_BUFFER;
}

/**
 * Add a forwarded message to the chat's batch and (re)arm the expiry — the TTL
 * slides from the LAST forward, so a long pack being forwarded slowly doesn't
 * expire mid-stream. Returns false when the pack is full (the message is counted
 * but its content dropped — the render says so).
 */
export function bufferForward(chatId: number, entry: BufferedForward): boolean {
  const cfg = loadConfig();
  let s = buffers.get(chatId);
  if (!s) {
    s = { entries: [], timer: null, overflow: 0 };
    buffers.set(chatId, s);
  }
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    void expireBatch(chatId);
  }, cfg.FORWARD_BUFFER_TTL_MINUTES * 60_000);
  s.timer.unref?.();

  if (s.entries.length >= cfg.FORWARD_BUFFER_MAX) {
    s.overflow++;
    return false;
  }
  s.entries.push(entry);
  return true;
}

/** Whether this exact message is sitting in the chat's batch (reaction handler). */
export function isBufferedMessage(chatId: number, messageId: number): boolean {
  return buffers.get(chatId)?.entries.some((e) => e.messageId === messageId) ?? false;
}

export function bufferedCount(chatId: number): number {
  return buffers.get(chatId)?.entries.length ?? 0;
}

/**
 * Drain the chat's batch: return the entries (empty array when there's nothing)
 * and clear the state. The caller owns what happens next; the reaction marks are
 * removed separately via `clearMarks` so a drain can't be slowed by Telegram.
 */
export function takeForwards(chatId: number): { entries: BufferedForward[]; overflow: number } {
  const s = buffers.get(chatId);
  if (!s) return { entries: [], overflow: 0 };
  if (s.timer) clearTimeout(s.timer);
  buffers.delete(chatId);
  return { entries: s.entries, overflow: s.overflow };
}

/**
 * Remove the bot's reaction from the batch's messages — the "button" disappears
 * once the pack is consumed (or expired), so a stale mark can't invite a tap
 * that would do nothing. Best-effort: a failed removal costs only a lingering
 * emoji.
 */
export async function clearMarks(
  api: Api,
  chatId: number,
  entries: BufferedForward[],
): Promise<void> {
  for (const e of entries) {
    try {
      await api.setMessageReaction(chatId, e.messageId, []);
    } catch {
      /* message deleted, rights revoked, … — the mark just stays */
    }
  }
}

async function expireBatch(chatId: number): Promise<void> {
  const { entries } = takeForwards(chatId);
  if (entries.length > 0) {
    logger.debug({ chatId, count: entries.length }, 'forward batch expired unused');
  }
  // Marks are cleared by the caller-side path only when an Api instance is
  // registered (index.ts can't reach here); see armExpiryApi below.
  const api = expiryApi;
  if (api && entries.length > 0) await clearMarks(api, chatId, entries);
}

// The expiry timer has no grammY context to clear marks with, so bot.ts hands
// the Api in once at startup. Optional: without it, expired packs keep their
// marks (harmless — a tap on a no-longer-buffered message is ignored).
let expiryApi: Api | null = null;
export function registerExpiryApi(api: Api): void {
  expiryApi = api;
}

const KIND_LABEL: Record<BufferedForward['kind'], string> = {
  text: '',
  voice: ', голосовое — расшифровка',
  photo: ', фото',
  document: ', файл — только имя и подпись',
};

/**
 * Render the batch as the context block injected into the turn that consumes it.
 * Numbered, each line naming the origin and channel, so the model can reference
 * «во втором сообщении» and never attributes the content to the sender.
 */
export function renderForwardBatch(entries: BufferedForward[], overflow: number): string {
  const lines = entries.map((e, i) => {
    const body = e.text.trim() || (e.kind === 'photo' ? '(фото без подписи)' : '(пусто)');
    return `${i + 1}. (${e.origin}${KIND_LABEL[e.kind]}) ${body}`;
  });
  const tail =
    overflow > 0 ? `\n…и ещё ${overflow} сообщений не поместилось в пачку (лимит).` : '';
  return (
    `[Пересланная пачка — ${entries.length} сообщений, только что пересланных в чат. ` +
    `Это ЧУЖИЕ слова из другого места (не слова отправителя) — контекст для просьбы ниже:\n` +
    `${lines.join('\n')}${tail}\nКонец пересланной пачки.]`
  );
}

/** Test hook: wipe all state (module-level maps survive between vitest cases). */
export function resetForwardBuffers(): void {
  for (const s of buffers.values()) if (s.timer) clearTimeout(s.timer);
  buffers.clear();
}
