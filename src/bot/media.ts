import type Anthropic from '@anthropic-ai/sdk';

/**
 * What an attached file IS, from the model's point of view. Telegram hands us a
 * `document` for anything sent "as a file" — an uncompressed photo, a receipt
 * PDF, a .csv export, a .zip — and the three things we can actually put in front
 * of the model are an image block, a PDF document block, and plain text. Anything
 * else is `unsupported`: we say so in one line instead of downloading megabytes we
 * cannot read.
 *
 * Pure on purpose (mime + filename in, verdict out): a wrong verdict here means a
 * malformed API request or a silently ignored file, so it's the part worth testing
 * without a Telegram context.
 */
export type FileKind = 'image' | 'pdf' | 'text' | 'unsupported';

/** The image media types the Messages API accepts, mapped from what Telegram sends. */
const IMAGE_MEDIA: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

const IMAGE_EXT: Record<string, keyof typeof IMAGE_MEDIA> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Text-ish files we can inline verbatim. Extensions carry the weight: Telegram
 *  loves `application/octet-stream` for anything it doesn't recognise. */
const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'ini',
  'log',
  'srt',
  'vtt',
  'sql',
]);

const TEXT_MIME = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/sql',
]);

export function fileExtension(fileName: string | undefined): string {
  const m = /\.([a-z0-9]+)$/i.exec((fileName ?? '').trim());
  return m ? m[1]!.toLowerCase() : '';
}

/** Decide what we can do with an attached file. */
export function classifyFile(mimeType: string | undefined, fileName?: string): FileKind {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0]!.trim();
  const ext = fileExtension(fileName);

  if (mime in IMAGE_MEDIA) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ext in IMAGE_EXT && (!mime || mime === 'application/octet-stream')) return 'image';
  if (mime.startsWith('text/') || TEXT_MIME.has(mime)) return 'text';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'unsupported';
}

/** The Anthropic media type for an image file (jpeg when we can only guess). */
export function imageMediaType(
  mimeType: string | undefined,
  fileName?: string,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0]!.trim();
  const direct = IMAGE_MEDIA[mime];
  if (direct) return direct;
  const byExt = IMAGE_EXT[fileExtension(fileName)];
  return byExt ? IMAGE_MEDIA[byExt]! : 'image/jpeg';
}

/** Human label used in the marker and in the "what should I do with it" question. */
export function fileKindLabel(kind: FileKind): string {
  switch (kind) {
    case 'image':
      return 'картинка';
    case 'pdf':
      return 'PDF';
    case 'text':
      return 'текстовый файл';
    default:
      return 'файл';
  }
}

export interface FileAttachment {
  kind: FileKind;
  fileName: string;
  mimeType: string | undefined;
}

/**
 * Turn a downloaded file into the content blocks that go into the turn. Text
 * files are inlined (and the cut is stated, so the model can't silently answer
 * from half a document); images and PDFs go in as their native block types.
 * Returns null for anything we can't render — the caller has already said so.
 */
export function buildFileBlocks(
  file: FileAttachment,
  bytes: Buffer,
  textMaxChars: number,
): Anthropic.ContentBlockParam[] | null {
  if (file.kind === 'image') {
    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageMediaType(file.mimeType, file.fileName),
          data: bytes.toString('base64'),
        },
      },
    ];
  }
  if (file.kind === 'pdf') {
    return [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
      },
    ];
  }
  if (file.kind === 'text') {
    const full = bytes.toString('utf8');
    const cut = full.length > textMaxChars;
    const body = cut ? full.slice(0, textMaxChars) : full;
    const tail = cut
      ? `\n…(файл обрезан: показано ${textMaxChars} из ${full.length} символов — ` +
        `скажи об этом, если это важно для ответа)`
      : '';
    const text = `Содержимое файла «${file.fileName}»:\n${body}${tail}`;
    return [{ type: 'text', text }];
  }
  return null;
}
