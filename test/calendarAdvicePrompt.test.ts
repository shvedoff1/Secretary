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

  it('pins the stale-airport road-time rule', () => {
    // The advice pass told a user «до аэропорта 15-20 минут» three times for a
    // flight out of Siem Reap: its memory described the OLD in-town airport
    // (REP), while the flight left from the new SAI, ~50 km out — over an hour
    // away. The rule makes the model key on the airport CODE, warns that its
    // remembered road time may be for a replaced airport, and forbids a
    // confident short travel time when unsure.
    expect(ADVICE_SYSTEM).toContain('по КОДУ из события');
    expect(ADVICE_SYSTEM).toContain('новый SAI — ~50 км');
    expect(ADVICE_SYSTEM).toContain('дорогу до СТАРОГО');
    expect(ADVICE_SYSTEM).toContain('НЕ называй');
    expect(ADVICE_SYSTEM).toContain('уверенное короткое время в пути');
    expect(ADVICE_SYSTEM).toContain('проверить маршрут в картах');
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
