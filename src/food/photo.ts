import type Anthropic from '@anthropic-ai/sdk';
import type { Api } from 'grammy';
import { getFoodEntry } from '../db/repos/food.repo.js';
import { downloadTelegramFileVia } from '../util/telegramFile.js';
import { sniffImageType } from '../summary/media.js';

/** Diary-scoped lookup: no dependence on chat logging, no model-supplied file id. */
export function makeFoodPhotoHandler(chatId: number, tgUserId: number, api: Api) {
  return async ({ entryId }: { entryId: number }): Promise<Anthropic.ToolResultBlockParam['content']> => {
    const entry = getFoodEntry(chatId, tgUserId, entryId);
    if (!entry?.source) return 'Фото этой записи недоступно. Не утверждай, что перечитал его; попроси исходное фото, если без него нельзя исправить запись.';
    try {
      const bytes = await downloadTelegramFileVia(api, entry.source.fileId);
      if (bytes.length > 5 * 1024 * 1024) return 'Фото слишком большое для чтения (больше 5 МБ). Попроси фрагмент с КБЖУ.';
      const mediaType = sniffImageType(bytes);
      if (!mediaType) return 'Не удалось прочитать формат фото. Попроси изображение повторно.';
      return [
        { type: 'text', text: `Исходное фото записи #${entry.id} «${entry.name}» за ${entry.localDate}. Перечитай цифры и выбранную базу: на 100 г или на порцию. Это источник существующей записи, не новый приём пищи.` },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
      ];
    } catch {
      return 'Не смог скачать исходное фото из Telegram. Не утверждай, что видел его; попроси прислать повторно.';
    }
  };
}
