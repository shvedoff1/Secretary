import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type Config } from '../config.js';
import { logger } from '../logger.js';
import { tierOf } from './tier.js';
import { DS_SEARCH_TOOLS, isDsSearchTool, runDsSearchTool } from './deepseekSearch.js';

/**
 * DeepSeek backend for every model call (`LLM_PROVIDER=deepseek`).
 *
 * DeepSeek serves an Anthropic-COMPATIBLE Messages endpoint, so unlike the
 * OpenAI translator nothing is re-shaped: the same SDK talks to
 * `<DEEPSEEK_BASE_URL>/anthropic` and the request each caller builds is only
 * CLEANED of what DeepSeek can't take, then answered as-is. What it can't take,
 * and what stands in:
 *   - the model ids → the tier's DeepSeek model (`tierOf`: dialogue/precise →
 *     PRO, hidden passes → FLASH);
 *   - `thinking: adaptive` / `output_config` / `cache_control` → explicit
 *     enabled/disabled thinking per tier; DeepSeek caches prefixes on its own;
 *   - Claude's SERVER `web_search` → DeepSeek Search/Fetch offered as function
 *     tools and run HERE (`deepseekSearch.ts`), returned to the caller as
 *     server-tool-shaped blocks so the dialogue loop ignores them exactly as it
 *     ignores Claude's own searches (`expandEmulated` turns them back into
 *     tool_use/tool_result on the next request);
 *   - images → DEEPSEEK_VISION_MODEL (V4.1 Flash sees pictures; Pro doesn't);
 *     PDFs (and images with the vision model `off`) → the whole call goes to
 *     DEEPSEEK_FALLBACK (Claude / OpenAI), or the media is replaced by a note
 *     when there is none;
 *   - DeepSeek DOWN (after the SDK's own retries) → the same fallback, so a vendor
 *     outage doesn't silence the bot.
 * No call site knows which vendor ran — same contract as openaiAssistant.ts.
 */

type AnyBlock = { type: string; [k: string]: unknown };
type CreateOpts = { timeout?: number; maxRetries?: number };
type Create = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts?: CreateOpts,
) => Promise<Anthropic.Message>;

/** Internal search rounds per call before handing back a pause_turn (Claude's
 *  server search uses max_uses 5 the same way). */
const MAX_SEARCH_ROUNDS = 5;
const THINKING_BUDGET = 8192;
/** Marks a result block this module wrote (never sent anywhere as-is). */
const EMULATED = 'deepseek_tool_output';

// ---------------------------------------------------------------------------
// Pure request cleaning (exported for tests)
// ---------------------------------------------------------------------------

function isEmulatedResult(b: AnyBlock): boolean {
  return (
    (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') &&
    (b.content as AnyBlock | undefined)?.type === EMULATED
  );
}

function stripCacheControl<T>(block: T): T {
  if (!block || typeof block !== 'object') return block;
  const { cache_control: _drop, ...rest } = block as Record<string, unknown>;
  if (Array.isArray(rest.content)) rest.content = rest.content.map((c) => stripCacheControl(c));
  return rest as T;
}

/** A text-sourced document block is just text; DeepSeek takes no documents. */
function plainTextDocument(b: AnyBlock): AnyBlock {
  const source = b.source as { type?: string; data?: string } | undefined;
  if (b.type === 'document' && source?.type === 'text') {
    const title = typeof b.title === 'string' && b.title ? `${b.title}\n` : '';
    return { type: 'text', text: `${title}${source.data ?? ''}` };
  }
  return b;
}

function cleanBlocks(content: Anthropic.MessageParam['content']): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content;
  return (content as unknown as AnyBlock[]).map((b) => {
    const clean = plainTextDocument(stripCacheControl(b));
    if (clean.type === 'tool_result' && Array.isArray(clean.content)) {
      clean.content = (clean.content as AnyBlock[]).map(plainTextDocument);
    }
    return clean;
  }) as unknown as Anthropic.MessageParam['content'];
}

/**
 * Undo the emulation on the way back in: an assistant message carrying
 * server_tool_use + emulated result blocks is split back into the
 * assistant tool_use / user tool_result exchange DeepSeek actually saw. Results
 * that END an assistant message belong to the same user turn as the caller's own
 * tool results (one model reply asked for both), so they merge into the next
 * user message instead of becoming one of their own.
 */
export function expandEmulated(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let carry: AnyBlock[] | null = null;
  for (const msg of messages) {
    if (msg.role === 'user' && carry) {
      const rest = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content as unknown as AnyBlock[]);
      out.push({ role: 'user', content: [...carry, ...rest] as unknown as Anthropic.ContentBlockParam[] });
      carry = null;
      continue;
    }
    if (msg.role !== 'assistant' || typeof msg.content === 'string' || !(msg.content as unknown as AnyBlock[]).some(isEmulatedResult)) {
      out.push(msg);
      continue;
    }
    let seg: AnyBlock[] = [];
    let pending: AnyBlock[] = [];
    for (const b of msg.content as unknown as AnyBlock[]) {
      if (b.type === 'server_tool_use') {
        seg.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      } else if (isEmulatedResult(b)) {
        const r = b.content as { text: string; is_error: boolean };
        pending.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: r.text, ...(r.is_error ? { is_error: true } : {}) });
      } else {
        if (pending.length > 0) {
          out.push({ role: 'assistant', content: seg as unknown as Anthropic.ContentBlockParam[] });
          out.push({ role: 'user', content: pending as unknown as Anthropic.ContentBlockParam[] });
          seg = [];
          pending = [];
        }
        seg.push(b);
      }
    }
    if (seg.length > 0) out.push({ role: 'assistant', content: seg as unknown as Anthropic.ContentBlockParam[] });
    if (pending.length > 0) carry = pending;
  }
  if (carry) out.push({ role: 'user', content: carry as unknown as Anthropic.ContentBlockParam[] });
  return out;
}

export interface MediaScan {
  image: boolean;
  pdf: boolean;
}

/** Does the request carry a picture or a binary document anywhere (the turn
 *  itself or a tool result — view_media)? */
export function scanMedia(messages: Anthropic.MessageParam[]): MediaScan {
  const scan: MediaScan = { image: false, pdf: false };
  const visit = (b: AnyBlock): void => {
    if (b.type === 'image') scan.image = true;
    else if (b.type === 'document' && (b.source as { type?: string } | undefined)?.type !== 'text') scan.pdf = true;
    else if (b.type === 'tool_result' && Array.isArray(b.content)) (b.content as AnyBlock[]).forEach(visit);
  };
  for (const m of messages) if (typeof m.content !== 'string') (m.content as unknown as AnyBlock[]).forEach(visit);
  return scan;
}

const IMAGE_NOTE = '[изображение: текущая модель не видит картинки — скажи об этом пользователю, не выдумывай, что на нём]';
const PDF_NOTE = '[PDF-файл: текущая модель не читает PDF — скажи об этом пользователю и попроси прислать текст]';

/** Media → a note, for when nobody can look at it. Pure. */
export function stripMedia(messages: Anthropic.MessageParam[], opts: { images: boolean }): Anthropic.MessageParam[] {
  const swap = (b: AnyBlock): AnyBlock => {
    if (b.type === 'image' && opts.images) return { type: 'text', text: IMAGE_NOTE };
    if (b.type === 'document' && (b.source as { type?: string } | undefined)?.type !== 'text') return { type: 'text', text: PDF_NOTE };
    if (b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: (b.content as AnyBlock[]).map(swap) };
    return b;
  };
  return messages.map((m) =>
    typeof m.content === 'string'
      ? m
      : { ...m, content: (m.content as unknown as AnyBlock[]).map(swap) as unknown as Anthropic.ContentBlockParam[] },
  );
}

/**
 * A request that may already hold DeepSeek's own output (a fallback mid-turn —
 * view_media opened a photo after two DeepSeek rounds) made safe for another
 * vendor: DeepSeek thinking blocks dropped (no valid signature elsewhere) and
 * emulated searches flattened to plain text, since the other vendor has no
 * function named web_search to pair them with. Pure.
 */
export function forFallback(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return m;
    const blocks: AnyBlock[] = [];
    for (const b of m.content as unknown as AnyBlock[]) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'server_tool_use') continue;
      if (isEmulatedResult(b)) {
        blocks.push({ type: 'text', text: `[результат поиска]\n${(b.content as { text: string }).text}` });
        continue;
      }
      blocks.push(b);
    }
    return { ...m, content: (blocks.length > 0 ? blocks : [{ type: 'text', text: '…' }]) as unknown as Anthropic.ContentBlockParam[] };
  });
}

/** The exact body sent to DeepSeek. Pure, for tests. */
export function toDeepseekParams(
  params: Anthropic.MessageCreateParamsNonStreaming,
  cfg: Config,
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const tier = tierOf(params.model, cfg);
  const tools: Anthropic.ToolUnion[] = [];
  for (const t of params.tools ?? []) {
    if ('input_schema' in t) tools.push(stripCacheControl(t));
    else if (t.name === 'web_search' && cfg.DEEPSEEK_SEARCH) tools.push(...DS_SEARCH_TOOLS);
    // Any other Anthropic server tool has no DeepSeek counterpart and drops.
  }
  const system =
    typeof params.system === 'string' || params.system === undefined
      ? params.system
      : params.system.map((b) => b.text).join('\n\n');
  const budget = Math.min(THINKING_BUDGET, params.max_tokens - 1024);
  const think = tier !== 'cheap' && cfg.DEEPSEEK_THINKING && budget >= 1024;
  const messages = expandEmulated(params.messages).map((m) => ({ ...m, content: cleanBlocks(m.content) }));
  return {
    model,
    max_tokens: params.max_tokens,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    thinking: think ? { type: 'enabled', budget_tokens: budget } : { type: 'disabled' },
    ...(!think && params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.stop_sequences ? { stop_sequences: params.stop_sequences } : {}),
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * One DeepSeek call with the search emulation: while the model only asks for
 * web_search/web_fetch, run them here and ask again; hand the caller the
 * accumulated content (searches as server-tool blocks) once the model answers or
 * asks for a real tool.
 */
export async function createWithSearch(
  create: Create,
  body: Anthropic.MessageCreateParamsNonStreaming,
  opts?: CreateOpts,
): Promise<Anthropic.Message> {
  const out: AnyBlock[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let messages = body.messages;
  for (let round = 0; ; round++) {
    const res = await create({ ...body, messages }, opts);
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;
    usage.cache_read_input_tokens += res.usage?.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += res.usage?.cache_creation_input_tokens ?? 0;
    const blocks = res.content as unknown as AnyBlock[];
    const searches = blocks.filter((b) => b.type === 'tool_use' && isDsSearchTool(b.name as string));
    const done = (content: AnyBlock[], stop: Anthropic.StopReason | null): Anthropic.Message =>
      ({ ...res, content: [...out, ...content], stop_reason: stop, usage }) as unknown as Anthropic.Message;
    if (searches.length === 0) return done(blocks, res.stop_reason);

    const results = await Promise.all(searches.map((b) => runDsSearchTool(b.name as string, b.input)));
    logger.info({ calls: searches.map((b) => b.name), round }, 'deepseek search');
    const emitted = blocks.map((b) =>
      b.type === 'tool_use' && isDsSearchTool(b.name as string)
        ? { type: 'server_tool_use', id: b.id, name: b.name, input: b.input }
        : b,
    );
    const resultBlocks = searches.map((b, i) => ({
      type: b.name === 'web_fetch' ? 'web_fetch_tool_result' : 'web_search_tool_result',
      tool_use_id: b.id,
      content: { type: EMULATED, text: results[i]!.text, is_error: results[i]!.isError },
    }));
    const realTool = blocks.some((b) => b.type === 'tool_use' && !isDsSearchTool(b.name as string));
    if (realTool) return done([...emitted, ...resultBlocks], 'tool_use');
    if (round + 1 >= MAX_SEARCH_ROUNDS) return done([...emitted, ...resultBlocks], 'pause_turn');
    out.push(...emitted, ...resultBlocks);
    messages = [
      ...messages,
      { role: 'assistant', content: blocks as unknown as Anthropic.ContentBlockParam[] },
      {
        role: 'user',
        content: resultBlocks.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.tool_use_id as string,
          content: r.content.text,
          ...(r.content.is_error ? { is_error: true } : {}),
        })),
      },
    ];
  }
}

export type FallbackKind = 'anthropic' | 'openai' | null;

/** Which vendor DEEPSEEK_FALLBACK resolves to with the keys at hand. Pure. */
export function resolveFallback(cfg: Config): FallbackKind {
  const want = cfg.DEEPSEEK_FALLBACK;
  if (want === 'none') return null;
  if (want === 'anthropic') return cfg.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (want === 'openai') return cfg.OPENAI_API_KEY ? 'openai' : null;
  if (cfg.ANTHROPIC_API_KEY) return 'anthropic';
  if (cfg.OPENAI_API_KEY) return 'openai';
  return null;
}

export interface DeepseekDeps {
  /** The DeepSeek-pointed SDK call (injected for tests). */
  deepseek: Create;
  /** The fallback vendor's call, already speaking the caller's (Claude) ids. */
  fallback: Create | null;
}

/** The `messages.create` that `getAnthropic()` exposes on LLM_PROVIDER=deepseek. */
export function deepseekCreate(deps: DeepseekDeps): Create {
  return async (params, opts) => {
    const cfg = loadConfig();
    const media = scanMedia(params.messages);
    const visionModel = cfg.DEEPSEEK_VISION_MODEL;
    const viaFallback = (why: string, err?: unknown) => {
      logger.warn({ why, model: params.model, err: err instanceof Error ? err.message : err }, 'deepseek → fallback');
      return deps.fallback!({ ...params, messages: forFallback(params.messages) }, opts);
    };

    let request = params;
    if (media.pdf || (media.image && !visionModel)) {
      if (deps.fallback) return viaFallback(media.pdf ? 'pdf' : 'image');
      request = { ...params, messages: stripMedia(params.messages, { images: !visionModel }) };
    }
    const tierModel = { dialogue: cfg.DEEPSEEK_ASSISTANT_MODEL, precise: cfg.DEEPSEEK_PRECISE_MODEL, cheap: cfg.DEEPSEEK_CHEAP_MODEL }[
      tierOf(params.model, cfg)
    ];
    const model = media.image && visionModel ? visionModel : tierModel;
    try {
      return await createWithSearch(deps.deepseek, toDeepseekParams(request, cfg, model), opts);
    } catch (err) {
      // A latency-bound pass (the expense classifier: maxRetries 0) fails open
      // on its own — doubling its wait on another vendor would defeat that.
      if (!deps.fallback || opts?.maxRetries === 0) throw err;
      return viaFallback('deepseek failed', err);
    }
  };
}
