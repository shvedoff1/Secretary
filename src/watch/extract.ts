import { createHash } from 'node:crypto';

// Pure text-extraction helpers for page watches. A watched page can be classic
// server-rendered HTML or a JS app shell whose schedule/stock data lives only in
// embedded JSON state (window.__NUXT__ etc.) — so keyword matching runs over the
// RAW html, and the model excerpt combines the visible text with raw-HTML windows
// around each keyword hit. That way both kinds of pages work without a headless
// browser, and the excerpt stays small enough to feed a cheap model every poll.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML page: scripts/styles dropped, tags stripped, entities decoded. */
export function htmlToText(html: string, maxLen = 6000): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return decoded.length > maxLen ? decoded.slice(0, maxLen) : decoded;
}

/** Which of the keywords occur in the raw html (case-insensitive substring). */
export function findKeywords(html: string, keywords: string[]): string[] {
  const haystack = html.toLowerCase();
  return keywords.filter((k) => {
    const needle = k.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

interface Range {
  start: number;
  end: number;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

export interface ExcerptOptions {
  /** Cap on the visible-text part. */
  visibleLen?: number;
  /** Raw-HTML window taken around each keyword hit, chars to each side. */
  window?: number;
  /** Hits per keyword to take windows around. */
  hitsPerKeyword?: number;
  /** Hard cap on the whole excerpt. */
  maxLen?: number;
}

/**
 * Build the model-facing excerpt of a page: the visible text first, then raw-HTML
 * snippets around each keyword occurrence (bounded per keyword and in total) so
 * data that only exists in embedded JSON still reaches the checking model.
 */
export function buildExcerpt(
  html: string,
  keywords: string[],
  opts: ExcerptOptions = {},
): string {
  const visibleLen = opts.visibleLen ?? 6000;
  const window = opts.window ?? 400;
  const hitsPerKeyword = opts.hitsPerKeyword ?? 3;
  const maxLen = opts.maxLen ?? 14000;

  const parts: string[] = [];
  const visible = htmlToText(html, visibleLen);
  if (visible) parts.push(`=== Видимый текст страницы ===\n${visible}`);

  const haystack = html.toLowerCase();
  const ranges: Range[] = [];
  for (const k of keywords) {
    const needle = k.trim().toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (let i = 0; i < hitsPerKeyword; i++) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      ranges.push({
        start: Math.max(0, at - window),
        end: Math.min(html.length, at + needle.length + window),
      });
      from = at + needle.length;
    }
  }
  const snippets = mergeRanges(ranges).map((r) => `…${html.slice(r.start, r.end)}…`);
  if (snippets.length > 0) {
    parts.push(`=== Фрагменты исходного HTML вокруг ключевых слов ===\n${snippets.join('\n---\n')}`);
  }

  const out = parts.join('\n\n');
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

/** Stable fingerprint of an excerpt — unchanged page => skip the LLM re-check. */
export function hashText(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
