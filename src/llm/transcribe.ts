import { loadConfig } from '../config.js';

/** Is speech-to-text configured? Voice messages are ignored when this is false. */
export function isTranscriptionEnabled(): boolean {
  return !!loadConfig().OPENAI_API_KEY;
}

/**
 * Transcribe an audio clip to text via OpenAI's audio transcription API.
 *
 * Telegram voice notes arrive as OGG/Opus; OpenAI accepts that directly, so we
 * upload the raw bytes as multipart/form-data. No SDK — a plain `fetch` keeps
 * the dependency surface unchanged. Throws if transcription isn't configured or
 * the request fails so callers can decide whether to surface an error.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) {
    throw new Error('transcription not configured (OPENAI_API_KEY unset)');
  }

  const form = new FormData();
  // Blob accepts a Uint8Array view; Buffer is one.
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append('model', cfg.OPENAI_TRANSCRIBE_MODEL);
  form.append('response_format', 'json');

  const res = await fetch(`${cfg.OPENAI_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`transcription failed: ${res.status} ${detail}`.trim());
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
