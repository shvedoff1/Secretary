import { describe, it, expect } from 'vitest';
import { ADVICE_SYSTEM } from '../src/llm/calendarAdvice.js';

// The advice model computes the airport lead time itself, and once told a user
// to show up an hour before an INTERNATIONAL flight — and never mentioned the
// arrival card the destination country requires filling in before landing.
// These rules are the fix; this test pins them so a prompt rewrite can't
// silently drop them.
describe('calendar advice prompt — flight rules', () => {
  it('pins the hard airport lead-time minimums', () => {
    expect(ADVICE_SYSTEM).toContain('за 2-3 часа до вылета');
    expect(ADVICE_SYSTEM).toContain('никогда не');
    expect(ADVICE_SYSTEM).toContain('советуй меньше 2');
    // The hour-before failure is called out by name so the model can't repeat it.
    expect(ADVICE_SYSTEM).toContain('«за час до вылета» на международный — это опоздание');
  });

  it('pins the border-formalities reminder (visas, online arrival cards)', () => {
    expect(ADVICE_SYSTEM).toContain('онлайн-декларации');
    expect(ADVICE_SYSTEM).toContain('TDAC');
    // The evening digest is where "fill it in tonight" belongs.
    expect(ADVICE_SYSTEM).toContain('заполнить их с вечера');
  });

  it('does not damn the airport buffer in the bad example', () => {
    // The old bad example read «в аэропорт лучше за 2 часа» — teaching the
    // model that naming a proper buffer is the mistake. The vagueness is the
    // mistake; the buffer must not appear in the anti-example.
    const badExample = ADVICE_SYSTEM.slice(
      ADVICE_SYSTEM.indexOf('Плохо'),
      ADVICE_SYSTEM.indexOf('Хорошо'),
    );
    expect(badExample).not.toContain('за 2 часа');
  });
});

// The model sent a user flying Etihad (EY) out of Bangkok to «T1 или T3 для
// Emirates» — the old prompt INVITED it («общее знание "в SGN — T2" — можно»).
// Terminals, gates and airlines now come only from the details block.
describe('calendar advice prompt — no terminals/airlines from memory', () => {
  it('bans terminals, gates and airlines that are not in the data', () => {
    expect(ADVICE_SYSTEM).toContain('ТЕРМИНАЛЫ, ГЕЙТЫ и');
    expect(ADVICE_SYSTEM).toContain('АВИАКОМПАНИИ — только из деталей');
    expect(ADVICE_SYSTEM).toContain('НИКОГДА из памяти');
    expect(ADVICE_SYSTEM).toContain('Не гадай авиакомпанию по коду рейса');
    // The concrete failure is named so the model can't repeat it.
    expect(ADVICE_SYSTEM).toContain('Бангкока BKK нет деления на T1/T3');
    expect(ADVICE_SYSTEM).toContain('Etihad, не Emirates');
  });

  it('no longer blesses "general knowledge" terminals', () => {
    expect(ADVICE_SYSTEM).not.toContain('T2») — можно');
    expect(ADVICE_SYSTEM).not.toContain('международный терминал — T2');
    // The good example still shows a terminal — sourced from the booking.
    expect(ADVICE_SYSTEM).toContain('в брони указан терминал 2');
  });
});
