import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

process.env.BOT_TOKEN = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.ADMIN_TELEGRAM_ID = '1';
process.env.DATABASE_PATH = ':memory:';

vi.mock('../src/bot/triggers.js', () => ({
  isAddressed: vi.fn(() => true),
  looksLikeExpenseForChat: vi.fn(() => false),
  captionLooksLikeSharedExpense: vi.fn(() => false),
  mentionsBotByName: vi.fn(() => false),
}));
vi.mock('../src/bot/flows/assist.js', () => ({
  runAndRespond: vi.fn(),
  senderName: () => 'Tester',
}));
vi.mock('../src/util/telegramFile.js', () => ({
  downloadTelegramFile: vi.fn(() => Promise.resolve(Buffer.from('jpegbytes'))),
}));
vi.mock('../src/bot/chatLog.js', () => ({ recordChatLog: vi.fn() }));
vi.mock('../src/bot/forwardBuffer.js', () => ({
  bufferForward: vi.fn(() => true),
  isForwardBufferEnabled: vi.fn(() => false),
  FORWARD_MARK: '🫡',
}));

import { onPhoto, handlePhotoTurn } from '../src/bot/handlers/onPhoto.js';
import { runAndRespond } from '../src/bot/flows/assist.js';
import { isAddressed } from '../src/bot/triggers.js';

const mockRun = vi.mocked(runAndRespond);
const mockAddressed = vi.mocked(isAddressed);

function ctx(caption?: string): Context {
  return {
    chat: { id: -100, type: 'group' },
    from: { id: 7, first_name: 'Tester' },
    me: { id: 42, username: 'bot' },
    message: { message_id: 1, photo: [{ file_id: 'small' }, { file_id: 'big' }], caption },
    reply: vi.fn(),
    react: vi.fn(),
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAddressed.mockReturnValue(true);
  mockRun.mockResolvedValue('replied');
});

describe('photos are looked at, not gated on Splid', () => {
  // The bug this pins: an addressed photo in a chat with no Splid group used to be
  // answered with «Подключите группу Splid командой /group <код>» — in EVERY mode,
  // assistant included. A photo is a photo; the model decides what it is.
  it('sends an addressed photo to the assistant even with no Splid group configured', async () => {
    await onPhoto(ctx('что тут написано?'));

    expect(mockRun).toHaveBeenCalledTimes(1);
    const call = mockRun.mock.calls[0]![1];
    const blocks = call.userContent as { type: string; text?: string }[];
    expect(blocks[0]!.type).toBe('image');
    expect(blocks[1]).toEqual({ type: 'text', text: 'что тут написано?' });
    expect(call.addressed).toBe(true);
  });

  it('never answers a photo with the Splid connect nag', async () => {
    const c = ctx();
    await onPhoto(c);
    expect(c.reply).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('takes the LARGEST photo size', async () => {
    const { downloadTelegramFile } = await import('../src/util/telegramFile.js');
    await onPhoto(ctx());
    expect(vi.mocked(downloadTelegramFile).mock.calls[0]![1]).toBe('big');
  });

  it('tags history as [фото], not [чек] — a picture is not presumed to be a bill', async () => {
    await handlePhotoTurn(ctx(), [{ file_id: 'big' }], 'глянь', true);
    expect(mockRun.mock.calls[0]![1].historyText).toBe('[фото] глянь');

    mockRun.mockClear();
    await handlePhotoTurn(ctx(), [{ file_id: 'big' }], '', true);
    expect(mockRun.mock.calls[0]![1].historyText).toBe('[фото]');
  });

  it('still ignores an unaddressed, uncaptioned photo in a group — no download, no tokens', async () => {
    const { downloadTelegramFile } = await import('../src/util/telegramFile.js');
    mockAddressed.mockReturnValue(false);

    await onPhoto(ctx());

    expect(mockRun).not.toHaveBeenCalled();
    expect(vi.mocked(downloadTelegramFile)).not.toHaveBeenCalled();
  });
});
