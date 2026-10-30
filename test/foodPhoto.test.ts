import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const download = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0x00]));
vi.mock('../src/util/telegramFile.js', () => ({ downloadTelegramFileVia: (...args: unknown[]) => download(...args as []) }));
let close: (() => void) | undefined;
beforeEach(() => {
  Object.assign(process.env, { BOT_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', ADMIN_TELEGRAM_ID: '1',
    DATABASE_PATH: ':memory:', ENABLE_CHAT_LOG: 'false' });
  vi.resetModules();
  download.mockClear();
});
afterEach(() => { close?.(); delete process.env.ENABLE_CHAT_LOG; });

it('reopens a persisted diary photo without chat logging and blocks other people/chats', async () => {
  const db = await import('../src/db/client.js');
  close = db.closeDb;
  (await import('../src/db/migrate.js')).migrate();
  const repo = await import('../src/db/repos/food.repo.js');
  const [entry] = repo.addFoodEntries({ chatId: 7, tgUserId: 7, localDate: '2026-10-30',
    meal: 'dinner', source: { fileId: 'persisted-photo', mediaType: 'image/jpeg' },
    items: [{ name: 'Блинчики', grams: 140, kcal: 263, protein: 5.7, fat: 13.6, carbs: 29.5 }] });
  const { makeFoodPhotoHandler } = await import('../src/food/photo.js');
  const api = {} as Parameters<typeof makeFoodPhotoHandler>[2];
  expect(await makeFoodPhotoHandler(7, 8, api)({ entryId: entry!.id })).toContain('недоступно');
  expect(await makeFoodPhotoHandler(8, 7, api)({ entryId: entry!.id })).toContain('недоступно');
  expect(download).not.toHaveBeenCalled();
  const blocks = await makeFoodPhotoHandler(7, 7, api)({ entryId: entry!.id });
  expect(download).toHaveBeenCalledWith(api, 'persisted-photo');
  expect(blocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
  download.mockRejectedValueOnce(new Error('expired'));
  expect(await makeFoodPhotoHandler(7, 7, api)({ entryId: entry!.id })).toContain('Не смог скачать');
});
