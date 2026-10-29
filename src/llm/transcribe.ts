import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

/** Is speech-to-text configured? Voice messages are ignored when this is false. */
export function isTranscriptionEnabled(): boolean {
  const cfg = loadConfig();
  return !!cfg.OPENAI_API_KEY || !!cfg.TRANSCRIBE_FALLBACK_BASE_URL;
}

interface SttEndpoint {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
}

/** The speech-to-text servers to try, in order: OpenAI, then the backup
 *  (TRANSCRIBE_FALLBACK_BASE_URL — e.g. the local whisper container). */
function endpoints(): SttEndpoint[] {
  const cfg = loadConfig();
  const out: SttEndpoint[] = [];
  if (cfg.OPENAI_API_KEY) {
    out.push({
      name: 'openai',
      baseUrl: cfg.OPENAI_BASE_URL,
      apiKey: cfg.OPENAI_API_KEY,
      model: cfg.OPENAI_TRANSCRIBE_MODEL,
      timeoutMs: cfg.TRANSCRIBE_TIMEOUT_MS,
    });
  }
  if (cfg.TRANSCRIBE_FALLBACK_BASE_URL) {
    out.push({
      name: 'fallback',
      baseUrl: cfg.TRANSCRIBE_FALLBACK_BASE_URL.replace(/\/+$/, ''),
      apiKey: cfg.TRANSCRIBE_FALLBACK_API_KEY,
      model: cfg.TRANSCRIBE_FALLBACK_MODEL,
      timeoutMs: cfg.TRANSCRIBE_FALLBACK_TIMEOUT_MS,
    });
  }
  return out;
}

async function transcribeAt(ep: SttEndpoint, audio: Buffer, filename: string, mimeType: string): Promise<string> {
  const cfg = loadConfig();
  const form = new FormData();
  // Blob accepts a Uint8Array view; Buffer is one.
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append('model', ep.model);
  form.append('response_format', 'json');
  // Domain priming: bias spelling/vocabulary toward expenses, amounts and names
  // so short spoken spends transcribe cleaner. Best-effort — skip when unset.
  if (cfg.OPENAI_TRANSCRIBE_PROMPT) {
    form.append('prompt', cfg.OPENAI_TRANSCRIBE_PROMPT);
  }

  const res = await fetch(`${ep.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(ep.timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`transcription failed: ${res.status} ${detail}`.trim());
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

/**
 * Transcribe an audio clip to text via an OpenAI-compatible transcription API.
 *
 * Telegram voice notes arrive as OGG/Opus; OpenAI (and faster-whisper servers)
 * accept that directly, so we upload the raw bytes as multipart/form-data. No
 * SDK — a plain `fetch` keeps the dependency surface unchanged. OpenAI goes
 * first; when it fails (down, quota, timeout) the backup server gets the same
 * clip. Throws only when every configured server failed (or none is), so
 * callers can decide whether to surface an error.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const eps = endpoints();
  if (eps.length === 0) {
    throw new Error('transcription not configured (OPENAI_API_KEY unset)');
  }
  let lastErr: unknown;
  for (const ep of eps) {
    try {
      return await transcribeAt(ep, audio, filename, mimeType);
    } catch (err) {
      lastErr = err;
      if (ep !== eps[eps.length - 1]) {
        logger.warn({ err: err instanceof Error ? err.message : err, stt: ep.name }, 'transcription failed, trying backup');
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
