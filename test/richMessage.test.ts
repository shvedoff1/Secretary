import { describe, it, expect, vi } from 'vitest';
import { sendRichMarkdown } from '../src/util/richMessage.js';
import type { Api } from 'grammy';

/**
 * A minimal fake grammY Api that records sendRichMessage / sendMessage calls and
 * can be told which of them should throw, so we can exercise the fallback chain
 * without a live bot.
 */
function makeApi(opts: { richThrows?: boolean; htmlThrows?: boolean } = {}) {
  const richCalls: Array<{ chatId: number; rich: unknown; other: Record<string, unknown> }> = [];
  const msgCalls: Array<{ chatId: number; text: string; other: Record<string, unknown> }> = [];
  const api = {
    sendRichMessage: vi.fn(
      async (chatId: number, rich: unknown, other: Record<string, unknown> = {}) => {
        richCalls.push({ chatId, rich, other });
        if (opts.richThrows) throw new Error('rich unsupported');
      },
    ),
    sendMessage: vi.fn(
      async (chatId: number, text: string, other: Record<string, unknown> = {}) => {
        msgCalls.push({ chatId, text, other });
        // First sendMessage is the HTML attempt; make only it throw when asked.
        if (opts.htmlThrows && msgCalls.length === 1) throw new Error('bad html');
      },
    ),
  };
  return { api: api as unknown as Api, richCalls, msgCalls, spies: api };
}

const TABLE = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');

describe('sendRichMarkdown', () => {
  it('sends the markdown verbatim as a rich message', async () => {
    const { api, richCalls, spies } = makeApi();
    await sendRichMarkdown(api, 42, TABLE, { replyToMessageId: 7 });
    expect(richCalls).toEqual([
      {
        chatId: 42,
        rich: { markdown: TABLE },
        other: { reply_parameters: { message_id: 7 } },
      },
    ]);
    // Native rich message succeeded → no fallback.
    expect(spies.sendMessage).not.toHaveBeenCalled();
  });

  it('omits reply_parameters when there is no reply target', async () => {
    const { api, richCalls } = makeApi();
    await sendRichMarkdown(api, 42, 'привет');
    expect(richCalls).toEqual([{ chatId: 42, rich: { markdown: 'привет' }, other: {} }]);
  });

  it('falls back to HTML when rich messages are unsupported', async () => {
    const { api, msgCalls, spies } = makeApi({ richThrows: true });
    await sendRichMarkdown(api, 42, '**bold**', { replyToMessageId: 7 });
    expect(spies.sendRichMessage).toHaveBeenCalledOnce();
    expect(msgCalls).toHaveLength(1);
    expect(msgCalls[0]!.chatId).toBe(42);
    expect(msgCalls[0]!.text).toBe('<b>bold</b>');
    expect(msgCalls[0]!.other).toMatchObject({
      parse_mode: 'HTML',
      reply_parameters: { message_id: 7 },
    });
  });

  it('renders a table as an aligned <pre> block in the HTML fallback', async () => {
    const { api, msgCalls } = makeApi({ richThrows: true });
    await sendRichMarkdown(api, 1, TABLE);
    expect(msgCalls[0]!.text).toBe('<pre>' + ['a | b', '--+--', '1 | 2'].join('\n') + '</pre>');
  });

  it('degrades to plain text when both rich and HTML fail', async () => {
    const { api, msgCalls } = makeApi({ richThrows: true, htmlThrows: true });
    await sendRichMarkdown(api, 1, '**bold**');
    expect(msgCalls).toHaveLength(2);
    // Second call is plain text (markers stripped, no parse_mode).
    expect(msgCalls[1]!.text).toBe('bold');
    expect(msgCalls[1]!.other.parse_mode).toBeUndefined();
  });

  it('disables the link preview only in the fallback paths', async () => {
    const { api, msgCalls } = makeApi({ richThrows: true });
    await sendRichMarkdown(api, 1, 'see https://t.me', { disableLinkPreview: true });
    expect(msgCalls[0]!.other).toMatchObject({
      link_preview_options: { is_disabled: true },
    });
  });
});
