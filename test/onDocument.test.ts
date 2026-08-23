import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

process.env.BOT_TOKEN = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.ADMIN_TELEGRAM_ID = '1';
process.env.DATABASE_PATH = ':memory:';

vi.mock('../src/bot/triggers.js', () => ({
  isAddressed: vi.fn(() => true),
  mentionsBotByName: vi.fn(() => false),
}));
vi.mock('../src/bot/flows/assist.js', () => ({
  runAndRespond: vi.fn(),
  senderName: () => 'Tester',
}));
vi.mock('../src/util/telegramFile.js', () => ({
  downloadTelegramFile: vi.fn(() => Promise.resolve(Buffer.from('%PDF-1.4 payload'))),
}));
vi.mock('../src/bot/chatLog.js', () => ({ recordChatLog: vi.fn() }));
vi.mock('../src/bot/forwardBuffer.js', () => ({
  bufferForward: vi.fn(() => true),
  isForwardBufferEnabled: vi.fn(() => true),
  FORWARD_MARK: '🫡',
}));

import { onDocument } from '../src/bot/handlers/onDocument.js';
import { runAndRespond } from '../src/bot/flows/assist.js';
import { isAddressed } from '../src/bot/triggers.js';
import { downloadTelegramFile } from '../src/util/telegramFile.js';
import { bufferForward } from '../src/bot/forwardBuffer.js';
import { hasPendingFile, takePendingFile, resetPendingFiles } from '../src/bot/pendingFile.js';
import { FILE_ATTACHMENT_MARKER } from '../src/llm/prompts.js';

const mockRun = vi.mocked(runAndRespond);
const mockAddressed = vi.mocked(isAddressed);
const mockDownload = vi.mocked(downloadTelegramFile);

interface DocOpts {
  fileName?: string;
  mime?: string;
  size?: number;
  caption?: string;
  forwardFrom?: boolean;
  replyToBot?: boolean;
  animation?: boolean;
}

function ctx(o: DocOpts = {}): Context {
  return {
    chat: { id: -100, type: 'group' },
    from: { id: 7, first_name: 'Tester' },
    me: { id: 42, username: 'bot' },
    message: {
      message_id: 1,
      caption: o.caption,
      animation: o.animation ? { file_id: 'gif' } : undefined,
      document: {
        file_id: 'F1',
        file_name: o.fileName ?? 'счёт.pdf',
        mime_type: o.mime ?? 'application/pdf',
        file_size: o.size ?? 1000,
      },
      forward_origin: o.forwardFrom ? { type: 'user', sender_user: { first_name: 'Вася' } } : undefined,
      reply_to_message: o.replyToBot ? { message_id: 9, from: { id: 42 } } : undefined,
    },
    reply: vi.fn(),
    react: vi.fn(),
  } as unknown as Context;
}

const replies = (c: Context) => vi.mocked(c.reply).mock.calls.map((a) => String(a[0]));

beforeEach(() => {
  vi.clearAllMocks();
  resetPendingFiles();
  mockAddressed.mockReturnValue(true);
  mockRun.mockResolvedValue('replied');
});

describe('a file with no explanation is ASKED about, not read', () => {
  it('parks the file and asks what to do — without downloading it', async () => {
    const c = ctx();
    await onDocument(c);

    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(replies(c)[0]).toContain('счёт.pdf');
    expect(replies(c)[0]).toContain('Что с ним сделать?');
    expect(hasPendingFile(-100)).toBe(true);
  });

  it('parks the newest file, replacing the previous one', async () => {
    await onDocument(ctx({ fileName: 'a.pdf' }));
    await onDocument(ctx({ fileName: 'b.pdf' }));
    expect(takePendingFile(-100)?.fileName).toBe('b.pdf');
    expect(hasPendingFile(-100)).toBe(false);
  });
});

describe('a file the user explained is read straight away', () => {
  it('reads a captioned PDF and puts the marker, the document and the ask in the turn', async () => {
    await onDocument(ctx({ caption: 'вытащи оттуда суммы' }));

    expect(hasPendingFile(-100)).toBe(false);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    const call = mockRun.mock.calls[0]![1];
    const blocks = call.userContent as { type: string; text?: string }[];
    expect(blocks[0]!.text).toContain(FILE_ATTACHMENT_MARKER);
    expect(blocks[0]!.text).toContain('счёт.pdf');
    expect(blocks[1]!.type).toBe('document');
    expect(blocks[2]).toEqual({ type: 'text', text: 'вытащи оттуда суммы' });
    expect(call.source).toBe('file');
    expect(call.historyText).toBe('[файл: счёт.pdf] вытащи оттуда суммы');
  });

  it('treats a file dropped as a reply to the bot as an answer to its own question', async () => {
    await onDocument(ctx({ replyToBot: true }));
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(hasPendingFile(-100)).toBe(false);
  });

  it('looks at an IMAGE sent as a file right away — that is a photo that skipped compression', async () => {
    await onDocument(ctx({ fileName: 'shot.png', mime: 'image/png' }));

    const blocks = mockRun.mock.calls[0]![1].userContent as { type: string }[];
    expect(blocks[1]!.type).toBe('image');
    expect(hasPendingFile(-100)).toBe(false);
  });
});

describe('what never costs a download', () => {
  it('ignores an unaddressed file in a group outright', async () => {
    mockAddressed.mockReturnValue(false);
    const c = ctx({ caption: 'смотрите' });

    await onDocument(c);

    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(c.reply).not.toHaveBeenCalled();
    expect(hasPendingFile(-100)).toBe(false);
  });

  it('says it cannot open an unsupported file instead of fetching megabytes', async () => {
    const c = ctx({ fileName: 'archive.zip', mime: 'application/zip', caption: 'глянь' });

    await onDocument(c);

    expect(mockDownload).not.toHaveBeenCalled();
    expect(replies(c)[0]).toContain('archive.zip');
    expect(hasPendingFile(-100)).toBe(false);
  });

  it('refuses a file over the size cap', async () => {
    const c = ctx({ size: 999 * 1024 * 1024, caption: 'разбери' });

    await onDocument(c);

    expect(mockDownload).not.toHaveBeenCalled();
    expect(replies(c)[0]).toContain('великоват');
  });

  it('leaves GIFs alone (Telegram sets `document` on animations too)', async () => {
    const c = ctx({ animation: true, caption: 'ахах' });

    await onDocument(c);

    expect(mockRun).not.toHaveBeenCalled();
    expect(c.reply).not.toHaveBeenCalled();
  });

  it('sends a FORWARDED file to the pack instead of answering it', async () => {
    const c = ctx({ forwardFrom: true, caption: 'вот' });

    await onDocument(c);

    expect(vi.mocked(bufferForward)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bufferForward).mock.calls[0]![1]).toMatchObject({ kind: 'document' });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('download failure', () => {
  it('says so rather than dying silently', async () => {
    mockDownload.mockRejectedValueOnce(new Error('boom'));
    const c = ctx({ caption: 'разбери' });

    await onDocument(c);

    expect(replies(c)[0]).toContain('Не смог скачать файл');
    expect(mockRun).not.toHaveBeenCalled();
  });
});
