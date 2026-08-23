// The assistant replies in GitHub-flavoured markdown, but Telegram won't render
// that on its own (raw "**bold**" leaks through). Telegram's HTML parse mode is
// far more forgiving than MarkdownV2 (only & < > need escaping), so we convert
// the common markdown the model emits into the supported HTML subset:
//   <b> <i> <s> <code> <pre> <a> <blockquote>.
//
// Telegram has NO table markup, so a GFM table ("| Боец | Итог |\n|---|---|")
// used to leak through as raw pipes. We render such tables into an aligned
// monospace <pre> block instead — the columns line up and it reads like a table.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Private-use sentinel wrapped around stashed code/tables so the formatting passes
// skip them; it never occurs in real text.
const S = String.fromCharCode(0xe000);

type Align = 'l' | 'r' | 'c';

/** Visible length in code points (so multi-byte chars pad correctly). */
function visualLen(s: string): number {
  return [...s].length;
}

/** Strip the inline markdown markers a table/monospace cell can't render. */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .trim();
}

/** Split a "| a | b |" row into trimmed cells, honouring escaped "\|" pipes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s
    .split(/(?<!\\)\|/)
    .map((c) => stripInline(c.replace(/\\\|/g, '|')));
}

/** A delimiter row is all cells like ":--", "--:", ":-:", "---". */
function isDelimiterRow(line: string): boolean {
  if (!line.includes('|') && !/^\s*:?-+:?\s*$/.test(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'c';
  if (right) return 'r';
  return 'l';
}

function pad(s: string, width: number, align: Align): string {
  const gap = Math.max(0, width - visualLen(s));
  if (align === 'r') return ' '.repeat(gap) + s;
  if (align === 'c') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + s + ' '.repeat(gap - left);
  }
  return s + ' '.repeat(gap);
}

/**
 * Format a parsed GFM table into aligned monospace text (no HTML). Columns are
 * padded to their widest cell and separated by " | ", with a dashed rule under
 * the header — inside a <pre> block this reads as a real table.
 */
function formatAlignedTable(headers: string[], aligns: Align[], rows: string[][]): string {
  const cols = headers.length;
  const width: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = visualLen(headers[c] ?? '');
    for (const row of rows) w = Math.max(w, visualLen(row[c] ?? ''));
    width[c] = w;
  }
  const line = (cells: string[]): string =>
    Array.from({ length: cols }, (_v, c) => pad(cells[c] ?? '', width[c]!, aligns[c] ?? 'l')).join(
      ' | ',
    );
  const rule = width.map((w) => '-'.repeat(w)).join('-+-');
  return [line(headers), rule, ...rows.map((r) => line(r))].join('\n');
}

/**
 * Walk the markdown line-by-line, replacing every GFM table block (a header row,
 * a delimiter row, then zero or more body rows) with `onTable`'s rendering. A run
 * that isn't a table is passed through untouched.
 */
function replaceTables(md: string, onTable: (aligned: string) => string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i]!;
    const delim = lines[i + 1];
    const headers = header.includes('|') ? splitRow(header) : [];
    // A real GFM table needs a header row, a delimiter row, and matching column
    // counts — the count check stops a stray "---" horizontal rule after a line
    // that happens to contain a pipe from being mistaken for a table.
    if (delim !== undefined && headers.length >= 1 && isDelimiterRow(delim) && splitRow(delim).length === headers.length) {
      const aligns = splitRow(delim).map(alignOf);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes('|') && lines[j]!.trim() !== '') {
        const cells = splitRow(lines[j]!);
        // Normalise to the header's column count.
        rows.push(Array.from({ length: headers.length }, (_v, c) => cells[c] ?? ''));
        j++;
      }
      out.push(onTable(formatAlignedTable(headers, aligns, rows)));
      i = j;
      continue;
    }
    out.push(header);
    i++;
  }
  return out.join('\n');
}

/** Convert markdown to the HTML subset Telegram supports (parse_mode: 'HTML'). */
export function mdToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];
  const tables: string[] = [];

  // 1) Stash fenced code blocks ```lang\n...``` and inline `code` so their
  //    contents are never touched by the inline-formatting passes.
  let s = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.replace(/\n+$/, ''));
    return `${S}C${codeBlocks.length - 1}${S}`;
  });

  // 2) Stash GFM tables as pre-rendered aligned <pre> blocks (Telegram has no
  //    table markup). Done before inline passes so the pipes survive untouched.
  s = replaceTables(s, (aligned) => {
    tables.push(`<pre>${escapeHtml(aligned)}</pre>`);
    return `${S}T${tables.length - 1}${S}`;
  });

  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlineCode.push(code);
    return `${S}I${inlineCode.length - 1}${S}`;
  });

  // 3) Escape HTML in the remaining prose.
  s = escapeHtml(s);

  // 4) Links [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) => `<a href="${url.replace(/"/g, '%22')}">${text}</a>`,
  );

  // 5) Bold (**…** / __…__) then strikethrough (~~…~~).
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');

  // 6) Headings → bold line.
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 7) Bullet markers (-, *, +) at line start → "• ".
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');

  // 8) Italic (*…*) — after bold/bullets so leftover single * are real emphasis.
  s = s.replace(
    /(^|[\s(])\*([^\s*][^*\n]*?)\*(?=[\s).,!?:;]|$)/g,
    '$1<i>$2</i>',
  );

  // 9) Blockquotes: runs of "> …" lines → <blockquote>…</blockquote> (the ">"
  //    became "&gt;" in the escape pass). Anchored at line start so a mid-line
  //    "a &gt; b" is left alone.
  s = s.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (block) => {
    const trailing = block.endsWith('\n') ? '\n' : '';
    const inner = block.replace(/\n$/, '').replace(/^&gt;[ \t]?/gm, '');
    return `<blockquote>${inner}</blockquote>${trailing}`;
  });

  // 10) Restore code (escaped) inside the proper tags, and tables (already HTML).
  s = s.replace(
    new RegExp(`${S}I(\\d+)${S}`, 'g'),
    (_m, i: string) => `<code>${escapeHtml(inlineCode[Number(i)]!)}</code>`,
  );
  s = s.replace(
    new RegExp(`${S}C(\\d+)${S}`, 'g'),
    (_m, i: string) => `<pre>${escapeHtml(codeBlocks[Number(i)]!)}</pre>`,
  );
  s = s.replace(new RegExp(`${S}T(\\d+)${S}`, 'g'), (_m, i: string) => tables[Number(i)]!);

  return s;
}

/** Strip markdown markers for a plain-text fallback (no rendering). */
export function stripMarkdown(md: string): string {
  let s = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  // Tables → aligned monospace text (still readable without a parse mode).
  s = replaceTables(s, (aligned) => aligned);
  return s
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/__([^\n]+?)__/g, '$1')
    .replace(/~~([^\n]+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
}
