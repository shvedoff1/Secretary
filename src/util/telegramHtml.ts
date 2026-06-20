// The assistant replies in GitHub-flavoured markdown, but Telegram won't render
// that on its own (raw "**bold**" leaks through). Telegram's HTML parse mode is
// far more forgiving than MarkdownV2 (only & < > need escaping), so we convert
// the common markdown the model emits into the supported HTML subset:
//   <b> <i> <s> <code> <pre> <a>.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Private-use sentinel wrapped around stashed code so the formatting passes skip
// it; it never occurs in real text.
const S = String.fromCharCode(0xe000);

/** Convert markdown to the HTML subset Telegram supports (parse_mode: 'HTML'). */
export function mdToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // 1) Stash fenced code blocks ```lang\n...``` and inline `code` so their
  //    contents are never touched by the inline-formatting passes.
  let s = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.replace(/\n+$/, ''));
    return `${S}C${codeBlocks.length - 1}${S}`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlineCode.push(code);
    return `${S}I${inlineCode.length - 1}${S}`;
  });

  // 2) Escape HTML in the remaining prose.
  s = escapeHtml(s);

  // 3) Links [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) => `<a href="${url.replace(/"/g, '%22')}">${text}</a>`,
  );

  // 4) Bold (**…** / __…__) then strikethrough (~~…~~).
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');

  // 5) Headings → bold line.
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 6) Bullet markers (-, *, +) at line start → "• ".
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');

  // 7) Italic (*…*) — after bold/bullets so leftover single * are real emphasis.
  s = s.replace(
    /(^|[\s(])\*([^\s*][^*\n]*?)\*(?=[\s).,!?:;]|$)/g,
    '$1<i>$2</i>',
  );

  // 8) Restore code (escaped) inside the proper tags.
  s = s.replace(
    new RegExp(`${S}I(\\d+)${S}`, 'g'),
    (_m, i: string) => `<code>${escapeHtml(inlineCode[Number(i)]!)}</code>`,
  );
  s = s.replace(
    new RegExp(`${S}C(\\d+)${S}`, 'g'),
    (_m, i: string) => `<pre>${escapeHtml(codeBlocks[Number(i)]!)}</pre>`,
  );

  return s;
}

/** Strip markdown markers for a plain-text fallback (no rendering). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/__([^\n]+?)__/g, '$1')
    .replace(/~~([^\n]+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ');
}
