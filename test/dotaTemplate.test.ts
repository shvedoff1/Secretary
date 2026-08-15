import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  formatValues,
  indexSpecialValues,
  renderText,
  resolveTemplate,
  stripHtml,
} from '../src/dota/template.js';
import type { FeedHero, FeedItem } from '../src/dota/feed.js';

function fixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/dota/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const hero = fixture<FeedHero>('hero_juggernaut_ru.json');
const blink = fixture<FeedItem>('item_blink_en.json');

describe('formatValues', () => {
  it('renders per-level values as a slash list', () => {
    expect(formatValues([25, 30, 35, 40])).toBe('25/30/35/40');
  });

  it('collapses a list that is identical at every level', () => {
    expect(formatValues([400, 400, 400, 400])).toBe('400');
  });

  it('trims float noise the way the client does', () => {
    expect(formatValues([5.3333335])).toBe('5.33');
    expect(formatValues([1.5])).toBe('1.5');
    expect(formatValues([12])).toBe('12');
  });

  it('returns null for nothing to render', () => {
    expect(formatValues([])).toBeNull();
    expect(formatValues(undefined)).toBeNull();
  });
});

describe('resolveTemplate', () => {
  const specials = [
    { name: 'mana_per_hit', values_float: [25, 30, 35, 40] },
    { name: 'AbilityDuration', values_float: [3] },
    { name: 'immunity_resist', values_float: [50] },
  ];

  it('substitutes %token% from special values', () => {
    expect(resolveTemplate('Burns %mana_per_hit% mana', specials)).toBe(
      'Burns 25/30/35/40 mana',
    );
  });

  it('matches token names case-insensitively (descriptions lowercase them)', () => {
    // The feed writes %abilityduration% while the value is named AbilityDuration.
    expect(resolveTemplate('Длится %abilityduration% сек.', specials)).toBe(
      'Длится 3 сек.',
    );
  });

  it('keeps a literal percent sign after a substituted value', () => {
    expect(resolveTemplate('+%immunity_resist%%% к сопротивлению', specials)).toBe(
      '+50% к сопротивлению',
    );
  });

  it('substitutes {s:token} talent templates, with or without the bonus_ prefix', () => {
    const talentValues = [{ name: 'value', values_float: [12] }];
    expect(resolveTemplate('+{s:value} Health Regen', talentValues)).toBe(
      '+12 Health Regen',
    );
    expect(resolveTemplate('+{s:bonus_value} Health Regen', talentValues)).toBe(
      '+12 Health Regen',
    );
  });

  it('renders an unknown token as ? rather than leaking the raw template', () => {
    const out = resolveTemplate('до %nope% метров', specials);
    expect(out).toBe('до ? метров');
    expect(out).not.toContain('%nope%');
  });

  it('accepts a prebuilt index as well as a raw list', () => {
    const index = indexSpecialValues(specials);
    expect(resolveTemplate('%mana_per_hit%', index)).toBe('25/30/35/40');
  });
});

describe('stripHtml', () => {
  it('turns the feed mini-HTML into plain lines', () => {
    expect(stripHtml('<h1>Active: Blink</h1> Teleport.<br><br>Cannot be used.')).toBe(
      'Active: Blink\nTeleport.\n\nCannot be used.',
    );
  });

  it('decodes entities and drops unknown tags', () => {
    expect(stripHtml('<span>Roshan &amp; Co</span>')).toBe('Roshan & Co');
  });
});

describe('renderText on real feed payloads', () => {
  it('resolves Blink Dagger fully — no leftover template tokens', () => {
    const text = renderText(blink.desc_loc ?? '', blink.special_values);
    expect(text).toContain('1200');
    expect(text).toContain('3');
    expect(text).not.toMatch(/%[a-z_]+%/i);
  });

  it("resolves Juggernaut's abilities, including a tooltip-only value", () => {
    const ward = (hero.abilities ?? []).find((a) => a.name === 'juggernaut_healing_ward');
    const text = renderText(ward?.desc_loc ?? '', ward?.special_values);
    // %healing_ward_movespeed_tooltip% and %abilityduration% both resolve.
    expect(text).not.toMatch(/%[a-z_]+%/i);
    expect(text).not.toContain('?');
  });

  it('leaves no unresolved token in any ability description of the fixture', () => {
    for (const ability of hero.abilities ?? []) {
      const text = renderText(ability.desc_loc ?? '', ability.special_values);
      expect(text, ability.name).not.toMatch(/%[a-zA-Z_]+%/);
      expect(text, ability.name).not.toMatch(/\{[a-z]:/);
    }
  });
});
