import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { getPersonaId, setPersonaId } from '../../db/repos/chatSettings.repo.js';
import { PERSONA_PRESETS, getPreset, resolvePersona } from '../../persona/presets.js';

/**
 * `/style` — pick the chat's persona (voice/style) from the presets defined in
 * `src/persona/presets.ts`. Available to anyone in the chat (it's a per-chat tone
 * choice, not an admin action). `/style` lists the presets and marks the active
 * one; `/style <id>` selects and pins one for this chat.
 */
export async function cmdStyle(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const cfg = loadConfig();
  const arg = (ctx.match?.toString() ?? '').trim().toLowerCase();

  const currentId = resolvePersona(getPersonaId(chatId) ?? cfg.DEFAULT_PERSONA).id;

  if (!arg) {
    const list = PERSONA_PRESETS.map((p) => {
      const mark = p.id === currentId ? '✅' : '▫️';
      return `${mark} <code>${p.id}</code> — ${p.name}: ${p.description}`;
    }).join('\n');
    await ctx.reply(
      `🎭 Стиль общения в этом чате: <b>${currentId}</b>\n\n${list}\n\n` +
        'Сменить: <code>/style &lt;id&gt;</code> (напр. <code>/style chill</code>).',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const preset = getPreset(arg);
  if (!preset) {
    const ids = PERSONA_PRESETS.map((p) => p.id).join(', ');
    await ctx.reply(`Нет такого стиля «${arg}». Доступные: ${ids}. Список: /style`);
    return;
  }

  setPersonaId(chatId, preset.id);
  await ctx.reply(`🎭 Стиль чата: <b>${preset.name}</b> (${preset.id}). ${preset.description}`, {
    parse_mode: 'HTML',
  });
}
