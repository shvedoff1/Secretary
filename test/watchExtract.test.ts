import { describe, it, expect } from 'vitest';
import {
  htmlToText,
  findKeywords,
  buildExcerpt,
  hashText,
} from '../src/watch/extract.js';

describe('htmlToText', () => {
  it('strips tags, scripts and styles, keeping visible text', () => {
    const html = `<html><head><style>.a{color:red}</style>
      <script>var state = {"secret": 1};</script></head>
      <body><h1>Афиша</h1><p>Титан <b>2026</b></p><noscript>no js</noscript></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Афиша');
    expect(text).toContain('Титан 2026');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('no js');
    expect(text).not.toContain('<');
  });

  it('decodes common entities', () => {
    expect(htmlToText('<p>Кофе&nbsp;&amp;&nbsp;чай &laquo;тут&raquo; &#x2014; да</p>')).toBe(
      'Кофе & чай «тут» — да',
    );
  });

  it('breaks block elements into lines and collapses whitespace', () => {
    const text = htmlToText('<div>один</div><div>  два   три </div>');
    expect(text).toBe('один\nдва три');
  });

  it('caps the output length', () => {
    const text = htmlToText(`<p>${'x'.repeat(10_000)}</p>`, 100);
    expect(text.length).toBe(100);
  });
});

describe('findKeywords', () => {
  it('matches case-insensitively in visible text', () => {
    expect(findKeywords('<p>Фильм ТИТАН</p>', ['титан', 'дракон'])).toEqual(['титан']);
  });

  it('matches inside embedded JSON/script data (JS-rendered pages)', () => {
    const html = '<script>window.__STATE__={"films":[{"title":"Титан","sessions":["19:30"]}]}</script>';
    expect(findKeywords(html, ['титан'])).toEqual(['титан']);
  });

  it('returns empty when nothing matches (and ignores blank keywords)', () => {
    expect(findKeywords('<p>Дракон</p>', ['титан', '  '])).toEqual([]);
  });
});

describe('buildExcerpt', () => {
  it('includes both the visible text and raw-HTML windows around keyword hits', () => {
    const html =
      '<body><p>Расписание</p></body>' +
      '<script>var s={"film":"Титан","times":["19:30","21:00"]}</script>';
    const excerpt = buildExcerpt(html, ['титан']);
    expect(excerpt).toContain('Расписание');
    expect(excerpt).toContain('19:30'); // session data living only in the script survives
    expect(excerpt).toContain('21:00');
  });

  it('omits the snippet section when no keyword occurs', () => {
    const excerpt = buildExcerpt('<p>Дракон</p>', ['титан']);
    expect(excerpt).toContain('Дракон');
    expect(excerpt).not.toContain('Фрагменты исходного HTML');
  });

  it('merges overlapping keyword windows instead of duplicating them', () => {
    const html = `<p>ааа титан титан ббб</p>`;
    const excerpt = buildExcerpt(html, ['титан'], { window: 50 });
    // Both hits sit in one merged window => the marker text appears only once.
    expect(excerpt.match(/ббб/g)?.length).toBe(2); // once in visible text, once in one snippet
  });

  it('respects the hard length cap', () => {
    const html = `<p>титан ${'y'.repeat(50_000)}</p>`;
    const excerpt = buildExcerpt(html, ['титан'], { maxLen: 500 });
    expect(excerpt.length).toBeLessThanOrEqual(500);
  });
});

describe('hashText', () => {
  it('is stable for equal input and differs for different input', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});
