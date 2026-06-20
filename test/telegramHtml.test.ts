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
});

describe('stripMarkdown', () => {
  it('removes markers for the plain-text fallback', () => {
    expect(stripMarkdown('**bold** and `code`')).toBe('bold and code');
    expect(stripMarkdown('- item')).toBe('• item');
  });
});
