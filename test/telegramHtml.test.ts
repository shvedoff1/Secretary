import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, stripMarkdown } from '../src/util/telegramHtml.js';

describe('mdToTelegramHtml', () => {
  it('converts bold', () => {
    expect(mdToTelegramHtml('я **очень** рад')).toBe('я <b>очень</b> рад');
    expect(mdToTelegramHtml('__жирно__')).toBe('<b>жирно</b>');
  });

  it('converts italic and strikethrough', () => {
    expect(mdToTelegramHtml('это *курсив* да')).toBe('это <i>курсив</i> да');
    expect(mdToTelegramHtml('~~зачёркнуто~~')).toBe('<s>зачёркнуто</s>');
  });

  it('converts inline code and escapes its contents', () => {
    expect(mdToTelegramHtml('запусти `a < b`')).toBe(
      'запусти <code>a &lt; b</code>',
    );
  });

  it('converts links', () => {
    expect(mdToTelegramHtml('[карта](https://maps.example/x)')).toBe(
      '<a href="https://maps.example/x">карта</a>',
    );
  });

  it('escapes stray html and leaves prose intact', () => {
    expect(mdToTelegramHtml('5 < 6 & 7 > 3')).toBe('5 &lt; 6 &amp; 7 &gt; 3');
  });

  it('turns bullets and headings into Telegram-friendly text', () => {
    expect(mdToTelegramHtml('# Заголовок')).toBe('<b>Заголовок</b>');
    expect(mdToTelegramHtml('- один\n- два')).toBe('• один\n• два');
  });

  it('handles a fenced code block', () => {
    expect(mdToTelegramHtml('```\nx=1\n```')).toBe('<pre>x=1</pre>');
  });

  it('renders a GFM table as an aligned <pre> block', () => {
    const md = [
      '| Боец | Тупка | Итог |',
      '|---|---|---|',
      '| Коля | 100 | 100 |',
      '| Миша | 5 | 5 |',
    ].join('\n');
    expect(mdToTelegramHtml(md)).toBe(
      '<pre>' +
        [
          'Боец | Тупка | Итог',
          '-----+-------+-----',
          'Коля | 100   | 100 ',
          'Миша | 5     | 5   ',
        ].join('\n') +
        '</pre>',
    );
  });

  it('honours right/center alignment and escapes table cell html', () => {
    const md = ['| a | b |', '|:-:|--:|', '| x<y | 1 & 2 |'].join('\n');
    expect(mdToTelegramHtml(md)).toBe(
      '<pre>' +
        [' a  |     b', '----+------', 'x&lt;y | 1 &amp; 2'].join('\n') +
        '</pre>',
    );
  });

  it('keeps prose around a table and strips inline markdown inside cells', () => {
    const md = ['Вот итог:', '', '| **Имя** | Сумма |', '|---|---|', '| Коля | 100 |'].join('\n');
    expect(mdToTelegramHtml(md)).toBe(
      'Вот итог:\n\n<pre>' +
        ['Имя  | Сумма', '-----+------', 'Коля | 100  '].join('\n') +
        '</pre>',
    );
  });

  it('does not treat a paragraph followed by a horizontal rule as a table', () => {
    expect(mdToTelegramHtml('раз | два\n---\nтри')).toBe('раз | два\n---\nтри');
  });

  it('renders blockquotes', () => {
    expect(mdToTelegramHtml('> цитата\n> вторая')).toBe(
      '<blockquote>цитата\nвторая</blockquote>',
    );
    // A mid-line ">" is left as plain text, not a blockquote.
    expect(mdToTelegramHtml('5 > 3')).toBe('5 &gt; 3');
  });
});

describe('stripMarkdown', () => {
  it('removes markers for the plain-text fallback', () => {
    expect(stripMarkdown('**bold** and `code`')).toBe('bold and code');
    expect(stripMarkdown('- item')).toBe('• item');
  });

  it('renders a table as aligned monospace text', () => {
    const md = ['| a | b |', '|---|---|', '| x | 10 |'].join('\n');
    expect(stripMarkdown(md)).toBe(['a | b ', '--+---', 'x | 10'].join('\n'));
  });

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> цитата')).toBe('цитата');
  });
});
