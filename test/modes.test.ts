import { describe, it, expect } from 'vitest';
import {
  MODES,
  MODE_NAMES,
  modeByCode,
  modeSpec,
  parseMode,
  renderModeCard,
  modeAllowsChime,
  modeAllowsHumor,
  modeAllowsReactions,
  modeAllowsSlang,
} from '../src/modes.js';
import { modeKeyboard } from '../src/bot/keyboards.js';

// The preset registry is the single source of truth: the picker buttons, /modes,
// /mode, /chat, the greeting and the setup card all render from it, and picking a
// preset writes its tone defaults into the chat's switches. A drifting entry
// silently changes how a whole chat behaves, so the shape is pinned here.

describe('personality preset registry', () => {
  it('covers every stored mode exactly once, with unique callback codes', () => {
    const modes = MODES.map((m) => m.mode);
    expect(new Set(modes).size).toBe(modes.length);
    expect(modes).toEqual(
      expect.arrayContaining(['secretary', 'assistant', 'funny', 'custom', 'tutor', 'dota']),
    );

    const codes = MODES.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
    // 'x' (ignore) and '?' (info) are taken by the picker's own buttons.
    expect(codes).not.toContain('x');
    expect(codes).not.toContain('?');
    // One char keeps `m:<code>:<chatId>` inside Telegram's 64-byte callback cap.
    for (const code of codes) expect(code).toHaveLength(1);
  });

  it('gives every preset a name, a label, a description and a greeting', () => {
    for (const m of MODES) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(20);
      expect(m.greeting.length).toBeGreaterThan(0);
    }
    const names = MODES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('resolves specs by mode and by code', () => {
    expect(modeSpec('assistant').code).toBe('a');
    expect(modeByCode('a')?.mode).toBe('assistant');
    expect(modeByCode('f')?.mode).toBe('funny');
    expect(modeByCode('c')?.mode).toBe('custom');
    expect(modeByCode('zzz')).toBeNull();
  });

  it('parses preset names written by a human — new names, old keys, both languages', () => {
    expect(parseMode('assistant')).toBe('assistant');
    expect(parseMode('calm')).toBe('assistant');
    expect(parseMode(' Спокойный ')).toBe('assistant');
    expect(parseMode(' Ассистент ')).toBe('assistant');
    expect(parseMode('SECRETARY')).toBe('secretary');
    expect(parseMode('surfer')).toBe('secretary');
    expect(parseMode('сёрфер')).toBe('secretary');
    expect(parseMode('весельчак')).toBe('funny');
    expect(parseMode('funny')).toBe('funny');
    expect(parseMode('кастом')).toBe('custom');
    expect(parseMode('custom')).toBe('custom');
    expect(parseMode('репетитор')).toBe('tutor');
    expect(parseMode('дота')).toBe('dota');
    expect(parseMode('турбо')).toBeNull();
  });

  it('lists every preset in the usage string and the info card', () => {
    for (const m of MODES) {
      expect(MODE_NAMES).toContain(m.name);
      // Every user-facing name must parse back to its own preset.
      expect(parseMode(m.name)).toBe(m.mode);
      expect(renderModeCard()).toContain(m.description);
    }
  });
});

describe('preset tone defaults', () => {
  it('ships the playful presets with everything on', () => {
    for (const mode of ['secretary', 'funny', 'dota'] as const) {
      expect(modeSpec(mode).defaults).toEqual({
        humor: true,
        slang: true,
        chime: true,
        reactions: true,
      });
    }
  });

  it('ships the calm preset quiet but still chat-adaptive: slang yes, jokes/chime/reactions no', () => {
    expect(modeSpec('assistant').defaults).toEqual({
      humor: false,
      slang: true,
      chime: false,
      reactions: false,
    });
  });

  it('ships the custom preset as a neutral canvas (slang on, the rest off)', () => {
    expect(modeSpec('custom').defaults).toEqual({
      humor: false,
      slang: true,
      chime: false,
      reactions: false,
    });
  });

  it('ships the tutor with everything off — and locked', () => {
    expect(modeSpec('tutor').defaults).toEqual({
      humor: false,
      slang: false,
      chime: false,
      reactions: false,
    });
    expect(modeSpec('tutor').toneLocked).toBe(true);
  });
});

describe('structural mode gates', () => {
  it('locks all tone features out of the tutor room, whatever the switches say', () => {
    expect(modeAllowsHumor('tutor')).toBe(false);
    expect(modeAllowsSlang('tutor')).toBe(false);
    expect(modeAllowsChime('tutor')).toBe(false);
    expect(modeAllowsReactions('tutor')).toBe(false);
  });

  it('leaves every other preset to the per-chat switches (structurally allowed)', () => {
    for (const mode of ['secretary', 'assistant', 'funny', 'custom', 'dota'] as const) {
      expect(modeAllowsHumor(mode)).toBe(true);
      expect(modeAllowsSlang(mode)).toBe(true);
      expect(modeAllowsChime(mode)).toBe(true);
      expect(modeAllowsReactions(mode)).toBe(true);
    }
  });
});

describe('mode picker keyboard', () => {
  it('offers every preset plus the info and ignore buttons, carrying the chat id', () => {
    const kb = modeKeyboard(-100500);
    const buttons = kb.inline_keyboard.flat();
    const data = buttons.map((b) => ('callback_data' in b ? b.callback_data : ''));

    for (const m of MODES) expect(data).toContain(`m:${m.code}:-100500`);
    expect(data).toContain('m:?:-100500');
    expect(data).toContain('m:x:-100500');
    expect(buttons).toHaveLength(MODES.length + 2);
    // Every callback fits Telegram's 64-byte limit.
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
  });
});
