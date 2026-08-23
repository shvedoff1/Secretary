import { describe, it, expect } from 'vitest';
import {
  buildFileBlocks,
  classifyFile,
  fileExtension,
  fileKindLabel,
  imageMediaType,
} from '../src/bot/media.js';

describe('classifyFile', () => {
  it('recognises the image types the Messages API accepts', () => {
    expect(classifyFile('image/jpeg', 'чек.jpg')).toBe('image');
    expect(classifyFile('image/png', 'shot.png')).toBe('image');
    expect(classifyFile('image/webp', 'x.webp')).toBe('image');
    expect(classifyFile('image/gif', 'x.gif')).toBe('image');
  });

  it('recognises a PDF by mime or by extension', () => {
    expect(classifyFile('application/pdf', 'счёт.pdf')).toBe('pdf');
    expect(classifyFile(undefined, 'счёт.pdf')).toBe('pdf');
    expect(classifyFile('application/octet-stream', 'счёт.PDF')).toBe('pdf');
  });

  it('falls back to the extension when Telegram sends octet-stream', () => {
    // Telegram labels plenty of files application/octet-stream; the name is then
    // the only signal we have.
    expect(classifyFile('application/octet-stream', 'photo_2026.jpeg')).toBe('image');
    expect(classifyFile('application/octet-stream', 'export.csv')).toBe('text');
  });

  it('recognises text-ish files', () => {
    expect(classifyFile('text/plain', 'notes.txt')).toBe('text');
    expect(classifyFile('application/json', 'data.json')).toBe('text');
    expect(classifyFile(undefined, 'README.md')).toBe('text');
    expect(classifyFile('text/csv; charset=utf-8', 'a.csv')).toBe('text');
  });

  it('calls everything else unsupported rather than downloading it', () => {
    expect(classifyFile('application/zip', 'archive.zip')).toBe('unsupported');
    expect(classifyFile('video/mp4', 'clip.mp4')).toBe('unsupported');
    expect(
      classifyFile(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc.docx',
      ),
    ).toBe('unsupported');
    expect(classifyFile(undefined, undefined)).toBe('unsupported');
  });

  it('never lets an image extension override a real non-image mime', () => {
    // A .png name on a zip payload would produce a malformed image block.
    expect(classifyFile('application/zip', 'trap.png')).toBe('unsupported');
  });
});

describe('imageMediaType', () => {
  it('normalises the jpeg aliases Telegram uses', () => {
    expect(imageMediaType('image/jpg', 'a.jpg')).toBe('image/jpeg');
    expect(imageMediaType('image/pjpeg', 'a.jpg')).toBe('image/jpeg');
  });

  it('reads the extension when the mime is unhelpful, else guesses jpeg', () => {
    expect(imageMediaType('application/octet-stream', 'a.PNG')).toBe('image/png');
    expect(imageMediaType(undefined, 'noextension')).toBe('image/jpeg');
  });
});

describe('fileExtension', () => {
  it('lowercases and ignores names without one', () => {
    expect(fileExtension('Отчёт.PDF')).toBe('pdf');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
    expect(fileExtension('noext')).toBe('');
    expect(fileExtension(undefined)).toBe('');
  });
});

describe('buildFileBlocks', () => {
  it('renders an image as a base64 image block', () => {
    const blocks = buildFileBlocks(
      { kind: 'image', fileName: 'a.png', mimeType: 'image/png' },
      Buffer.from('hi'),
      100,
    );
    expect(blocks).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from('hi').toString('base64') },
      },
    ]);
  });

  it('renders a PDF as a base64 document block', () => {
    const blocks = buildFileBlocks(
      { kind: 'pdf', fileName: 'a.pdf', mimeType: 'application/pdf' },
      Buffer.from('%PDF-1.4'),
      100,
    );
    expect(blocks![0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
    });
  });

  it('inlines a text file verbatim under the budget', () => {
    const blocks = buildFileBlocks(
      { kind: 'text', fileName: 'n.txt', mimeType: 'text/plain' },
      Buffer.from('привет\nмир'),
      100,
    );
    const text = (blocks![0] as { text: string }).text;
    expect(text).toContain('привет\nмир');
    expect(text).not.toContain('обрезан');
  });

  it('cuts an oversized text file AND says so, so the model cannot answer as if it read it all', () => {
    const blocks = buildFileBlocks(
      { kind: 'text', fileName: 'big.txt', mimeType: 'text/plain' },
      Buffer.from('a'.repeat(50)),
      10,
    );
    const text = (blocks![0] as { text: string }).text;
    expect(text).toContain('a'.repeat(10));
    expect(text).not.toContain('a'.repeat(11));
    expect(text).toContain('обрезан');
    expect(text).toContain('10');
    expect(text).toContain('50');
  });

  it('returns null for a file kind it cannot render', () => {
    expect(
      buildFileBlocks({ kind: 'unsupported', fileName: 'x.zip', mimeType: 'application/zip' }, Buffer.from(''), 10),
    ).toBeNull();
  });
});

describe('fileKindLabel', () => {
  it('names each kind in the chat language', () => {
    expect(fileKindLabel('pdf')).toBe('PDF');
    expect(fileKindLabel('image')).toBe('картинка');
    expect(fileKindLabel('text')).toBe('текстовый файл');
    expect(fileKindLabel('unsupported')).toBe('файл');
  });
});
