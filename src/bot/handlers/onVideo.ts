import type { Context } from 'grammy';
import { senderName } from '../flows/assist.js';
import { isForwarded } from '../forwarded.js';
import { recordChatLog } from '../chatLog.js';
import { logRefs } from '../threads.js';

/**
 * Videos and video notes («кружочки»): LOGGED, never processed. Watching a video
 * is far too expensive to do on every clip in a busy chat, so the clip is kept as
 * a REFERENCE — who sent it, when, its caption, a link back to the message, and
 * its thumbnail's file_id — and the model can open that single still frame on
 * demand with `view_media` («что на том видео со скрином бага?»). The bot never
 * replies to a video by itself.
 */
export async function onVideo(ctx: Context): Promise<void> {
  const msg = ctx.message;
  if (!msg || !ctx.chat || !ctx.from) return;
  const video = msg.video;
  const note = msg.video_note;
  if (!video && !note) return;

  const caption = msg.caption?.trim() ?? '';
  const seconds = video?.duration ?? note?.duration ?? 0;
  const length = seconds > 0 ? `, ${formatDuration(seconds)}` : '';
  const label = note ? `(кружок${length})` : `(видео${length})`;

  recordChatLog({
    chatId: ctx.chat.id,
    role: 'user',
    kind: 'video',
    tgUserId: ctx.from.id,
    senderName: senderName(ctx),
    content: caption ? `${label} ${caption}` : label,
    forwarded: isForwarded(msg),
    ...logRefs(msg),
    mediaFileId: (video?.thumbnail ?? note?.thumbnail)?.file_id ?? null,
  });
}

/** 75 → «1:15». */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
