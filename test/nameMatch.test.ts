import { describe, it, expect } from 'vitest';
import { nearName, editDistance } from '../src/util/nameMatch.js';

// The matcher exists to recognise a name corrupted by a lossy channel (a voice
// transcript, a typo) as someone we already know. Its whole value is in the FLOORS:
// Russian given names sit one edit apart routinely, so merging two real people is a
// worse failure than the phantom person the matcher prevents.

describe('editDistance', () => {
  it('measures small edits', () => {
    expect(editDistance('швед', 'швец', 2)).toBe(1);
    expect(editDistance('шведов', 'шведав', 2)).toBe(1);
    expect(editDistance('маша', 'маша', 2)).toBe(0);
  });

  it('abandons early past the budget instead of computing the true distance', () => {
    // Only the "over budget" fact matters to callers, so anything above max may be
    // reported as max + 1.
    expect(editDistance('швед', 'кузнецов', 1)).toBeGreaterThan(1);
    expect(editDistance('а', 'ббббббб', 2)).toBeGreaterThan(2);
  });
});

describe('nearName', () => {
  it('matches a mis-heard name against the real one', () => {
    expect(nearName('Швец', 'Швед')).toBe(true);
    expect(nearName('Шведав', 'Шведов')).toBe(true);
  });

  it('matches a garbled first name against a "First Last" spelling', () => {
    expect(nearName('Швец', 'Швед Иванов')).toBe(true);
    expect(nearName('Марья Иванова', 'Марина')).toBe(false);
  });

  it('folds ё and case the way names are actually written', () => {
    expect(nearName('пётр', 'Петр')).toBe(true);
  });

  it('keeps SHORT names apart — this is the whole point of the floor', () => {
    // One edit apart, but both are real, common, different people.
    expect(nearName('Аня', 'Ваня')).toBe(false);
    expect(nearName('Ася', 'Вася')).toBe(false);
  });

  it('keeps names apart when only the FIRST letter differs', () => {
    // Long enough to clear the length floor and one edit apart, yet plainly two
    // different people — the shared-prefix rule is what separates them.
    expect(nearName('Дима', 'Рима')).toBe(false);
    expect(nearName('Коля', 'Толя')).toBe(false);
    expect(nearName('Марина', 'Карина')).toBe(false);
  });

  it('rejects genuinely different names', () => {
    expect(nearName('Швец', 'Кузнецов')).toBe(false);
    expect(nearName('Маша Иванова', 'Пётр Сидоров')).toBe(false);
    expect(nearName('', 'Швед')).toBe(false);
    expect(nearName('Швед', '')).toBe(false);
  });

  it('allows two edits only once names are long enough to afford them', () => {
    expect(nearName('Александар', 'Александр')).toBe(true);
    // Same prefix, but two edits on a short name — refused.
    expect(nearName('Саша', 'Сашуля')).toBe(false);
    expect(nearName('Кот', 'Ток')).toBe(false);
  });
});
