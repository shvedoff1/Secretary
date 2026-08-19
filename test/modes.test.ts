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

// The mode registry is the single source of truth: the picker buttons, /modes,
// /mode, /chat and the greeting all render from it, and the humor/slang/chime/
// reaction gates read their flags off it. A drifting entry silently changes how a
// whole chat behaves, so the shape is pinned here.

describe('mode registry', () => {
  it('covers every stored mode exactly once, with unique callback codes', () => {
    const modes = MODES.map((m) => m.mode);
    expect(new Set(modes).size).toBe(modes.length);
    expect(modes).toEqual(expect.arrayContaining(['secretary', 'assistant', 'tutor', 'dota']));

    const codes = MODES.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
    // 'x' (ignore) and '?' (info) are taken by the picker's own buttons.
    expect(codes).not.toContain('x');
    expect(codes).not.toContain('?');
    // One char keeps `m:<code>:<chatId>` inside Telegram's 64-byte callback cap.
    for (const code of codes) expect(code).toHaveLength(1);
  });

  it('gives every mode a label, a description and a greeting', () => {
    for (const m of MODES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(20);
      expect(m.greeting.length).toBeGreaterThan(0);
    }
  });

  it('resolves specs by mode and by code', () => {
    expect(modeSpec('assistant').code).toBe('a');
    expect(modeByCode('a')?.mode).toBe('assistant');
    expect(modeByCode('zzz')).toBeNull();
  });

  it('parses mode names written by a human, in either language', () => {
    expect(parseMode('assistant')).toBe('assistant');
    expect(parseMode(' Ассистент ')).toBe('assistant');
    expect(parseMode('SECRETARY')).toBe('secretary');
    expect(parseMode('репетитор')).toBe('tutor');
    expect(parseMode('дота')).toBe('dota');
    expect(parseMode('турбо')).toBeNull();
  });

  it('lists every mode in the usage string and the info card', () => {
    for (const m of MODES) {
      expect(MODE_NAMES).toContain(m.mode);
      expect(renderModeCard()).toContain(m.description);
    }
  });
});

describe('mode feature stances', () => {
  it('keeps the secretary and dota chats playful', () => {
    for (const mode of ['secretary', 'dota'] as const) {
      expect(modeAllowsHumor(mode)).toBe(true);
      expect(modeAllowsSlang(mode)).toBe(true);
      expect(modeAllowsChime(mode)).toBe(true);
      expect(modeAllowsReactions(mode)).toBe(true);
    }
  });

  it('makes the assistant calm but still chat-adaptive: slang yes, jokes/chime/reactions no', () => {
    expect(modeAllowsSlang('assistant')).toBe(true);
    expect(modeAllowsHumor('assistant')).toBe(false);
    expect(modeAllowsChime('assistant')).toBe(false);
    expect(modeAllowsReactions('assistant')).toBe(false);
  });

  it('keeps the tutor room free of all of it', () => {
    expect(modeAllowsHumor('tutor')).toBe(false);
    expect(modeAllowsSlang('tutor')).toBe(false);
    expect(modeAllowsChime('tutor')).toBe(false);
    expect(modeAllowsReactions('tutor')).toBe(false);
  });
});

describe('mode picker keyboard', () => {
  it('offers every mode plus the info and ignore buttons, carrying the chat id', () => {
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
