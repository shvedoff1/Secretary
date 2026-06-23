import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ADMIN_TELEGRAM_ID: '123',
};

/** Reset env to a known baseline plus the given overrides (undefined deletes). */
function setEnv(extra: Record<string, string | undefined>): void {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_TRANSCRIBE_MODEL;
  delete process.env.OPENAI_BASE_URL;
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('transcribe', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isTranscriptionEnabled tracks OPENAI_API_KEY presence', async () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const off = await import('../src/llm/transcribe.js');
    expect(off.isTranscriptionEnabled()).toBe(false);

    vi.resetModules();
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    const on = await import('../src/llm/transcribe.js');
    expect(on.isTranscriptionEnabled()).toBe(true);
  });

  it('uploads audio as multipart and returns the trimmed transcript', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_TRANSCRIBE_MODEL: 'whisper-1' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: '  потратил 500 на такси  ' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { transcribeAudio } = await import('../src/llm/transcribe.js');
    const text = await transcribeAudio(Buffer.from('ogg-bytes'), 'voice.ogg', 'audio/ogg');

    expect(text).toBe('потратил 500 на такси');
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(init.body).toBeInstanceOf(FormData);

    const body = init.body as FormData;
    expect(body.get('model')).toBe('whisper-1');
    expect(body.get('file')).toBeInstanceOf(Blob);
  });

  it('honors a custom OPENAI_BASE_URL', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://proxy.example.com/v1' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { transcribeAudio } = await import('../src/llm/transcribe.js');
    await transcribeAudio(Buffer.from('x'), 'voice.ogg', 'audio/ogg');

    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example.com/v1/audio/transcriptions');
  });

  it('throws when transcription is not configured', async () => {
    setEnv({ OPENAI_API_KEY: undefined });
    const { transcribeAudio } = await import('../src/llm/transcribe.js');
    await expect(transcribeAudio(Buffer.from('x'), 'voice.ogg', 'audio/ogg')).rejects.toThrow(
      /not configured/,
    );
  });

  it('throws on a non-ok response', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })));
    const { transcribeAudio } = await import('../src/llm/transcribe.js');
    await expect(transcribeAudio(Buffer.from('x'), 'voice.ogg', 'audio/ogg')).rejects.toThrow(
      /transcription failed: 400/,
    );
  });
});
