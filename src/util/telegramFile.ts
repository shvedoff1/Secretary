import type { Context } from 'grammy';
import { loadConfig } from '../config.js';

/** Download a Telegram file (by file_id) into a Buffer via the Bot file API. */
export async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const { BOT_TOKEN } = loadConfig();
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('no file_path from Telegram');
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
