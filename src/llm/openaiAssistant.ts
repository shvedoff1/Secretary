import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * OpenAI backend for every model call (`LLM_PROVIDER=openai`).
 *
 * The codebase is written against Anthropic's message shapes — tool_use blocks,
 * tool_result blocks, stop_reason — and `runAssistant`'s ~20-tool dispatch reads
 * them. Rather than fork each caller, this module is a TRANSLATOR: it takes the
 * exact request a caller would send to Claude (system prompt, tool schemas,
 * messages), maps it onto the OpenAI Responses API, and maps the answer back into
 * Anthropic-shaped content. `client.ts` plugs it in under `getAnthropic()`, so
 * prompts, context blocks, tools and every handler stay identical — a comparison
 * between the vendors is a comparison of the models, not of two code paths.
 *
 * Plain `fetch`, no SDK — same transport as the humorizer and transcription.
 * The pure converters are exported for tests.
 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelRequest {
  model: string;
  maxTokens: number;
  system: string;
  tools: Anthropic.ToolUnion[];
  messages: Anthropic.MessageParam[];
  effort: ReasoningEffort;
  /** Per-attempt cap (default 120s). */
  timeoutMs?: number;
  /** Retries after the first attempt (default 3); a latency-bound pass sends 0. */
  maxRetries?: number;
}

/** The slice of an Anthropic `Message` the assistant loop reads. */
export interface ModelTurn {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.StopReason | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
}

type InputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; filename: string; file_data: string };

export type ResponsesInputItem =
  | { role: 'user'; content: InputPart[] }
  | { role: 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export type ResponsesTool =
  | {
      type: 'function';
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
      strict: false;
    }
  | { type: 'web_search' };

/** Anthropic tool list → Responses tools. The server-side web_search maps onto
 *  OpenAI's own built-in search; other server tools have no counterpart and drop. */
export function toResponsesTools(tools: Anthropic.ToolUnion[]): ResponsesTool[] {
  const out: ResponsesTool[] = [];
  for (const tool of tools) {
    if ('input_schema' in tool) {
      out.push({
        type: 'function',
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema as Record<string, unknown>,
        // The schemas were written for Claude (optional fields, open objects);
        // strict mode would reject them, and the handlers validate with Zod anyway.
        strict: false,
      });
    } else if (tool.name === 'web_search') {
      out.push({ type: 'web_search' });
    }
  }
  return out;
}

type AnyBlock = { type: string; [k: string]: unknown };

function mediaPart(block: AnyBlock): InputPart | null {
  const source = block.source as
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
    | { type: 'text'; data: string }
    | undefined;
  if (!source) return null;
  if (block.type === 'image') {
    if (source.type === 'base64') {
      return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` };
    }
    if (source.type === 'url') return { type: 'input_image', image_url: source.url };
    return null;
  }
  if (block.type === 'document') {
    if (source.type === 'text') return { type: 'input_text', text: source.data };
    if (source.type === 'base64') {
      const title = typeof block.title === 'string' && block.title ? block.title : 'document.pdf';
      return {
        type: 'input_file',
        filename: title,
        file_data: `data:${source.media_type};base64,${source.data}`,
      };
    }
  }
  return null;
}

/** User-side content (text / image / document blocks) → input parts. */
function userParts(content: Anthropic.MessageParam['content']): InputPart[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  const parts: InputPart[] = [];
  for (const raw of content as unknown as AnyBlock[]) {
    if (raw.type === 'text') parts.push({ type: 'input_text', text: raw.text as string });
    else {
      const part = mediaPart(raw);
      if (part) parts.push(part);
    }
  }
  return parts;
}

/**
 * Anthropic messages → Responses `input` items. A user message carrying
 * tool_result blocks becomes function_call_output items (images inside a result —
 * view_media — can't ride in the output string, so they follow as a user message);
 * an assistant message becomes its text plus one function_call per tool_use.
 */
export function toResponsesInput(messages: Anthropic.MessageParam[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        if (msg.content) items.push({ role: 'assistant', content: msg.content });
        continue;
      }
      const text = (msg.content as unknown as AnyBlock[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('');
      if (text) items.push({ role: 'assistant', content: text });
      for (const b of msg.content as unknown as AnyBlock[]) {
        if (b.type !== 'tool_use') continue;
        items.push({
          type: 'function_call',
          call_id: b.id as string,
          name: b.name as string,
          arguments: JSON.stringify(b.input ?? {}),
        });
      }
      continue;
    }

    if (typeof msg.content === 'string') {
      items.push({ role: 'user', content: userParts(msg.content) });
      continue;
    }
    const blocks = msg.content as unknown as AnyBlock[];
    const rest: AnyBlock[] = [];
    const resultMedia: InputPart[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool_result') {
        rest.push(b);
        continue;
      }
      const content = b.content as string | AnyBlock[] | undefined;
      let output = '';
      if (typeof content === 'string') output = content;
      else if (Array.isArray(content)) {
        output = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text as string)
          .join('\n');
        for (const c of content) {
          const part = c.type === 'text' ? null : mediaPart(c);
          if (part) resultMedia.push(part);
        }
      }
      if (b.is_error) output = `ERROR: ${output}`;
      items.push({ type: 'function_call_output', call_id: b.tool_use_id as string, output });
    }
    if (resultMedia.length > 0) {
      items.push({
        role: 'user',
        content: [{ type: 'input_text', text: '[вложение из результата инструмента]' }, ...resultMedia],
      });
    }
    if (rest.length > 0) {
      const parts = userParts(rest as unknown as Anthropic.ContentBlockParam[]);
      if (parts.length > 0) items.push({ role: 'user', content: parts });
    }
  }
  return items;
}

interface ResponsesOutputItem {
  type: string;
  content?: { type: string; text?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/** Responses answer → Anthropic-shaped turn (text + tool_use blocks, stop_reason). */
export function fromResponsesOutput(body: ResponsesBody): ModelTurn {
  const content: Anthropic.ContentBlock[] = [];
  let toolCalls = 0;
  for (const item of body.output ?? []) {
    if (item.type === 'message') {
      const text = (item.content ?? [])
        .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      if (text) content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
    } else if (item.type === 'function_call' && item.call_id && item.name) {
      let input: unknown = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        // Unparseable arguments still reach the handler's Zod check, which turns
        // them into an is_error tool result the model can recover from.
        logger.warn({ tool: item.name }, 'openai assistant: tool arguments are not JSON');
        input = {};
      }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input } as Anthropic.ToolUseBlock);
      toolCalls++;
    }
  }
  const stop_reason: Anthropic.StopReason =
    toolCalls > 0
      ? 'tool_use'
      : body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens'
        ? 'max_tokens'
        : 'end_turn';
  return {
    content,
    stop_reason,
    usage: {
      input_tokens: body.usage?.input_tokens ?? 0,
      output_tokens: body.usage?.output_tokens ?? 0,
      cache_read_input_tokens: body.usage?.input_tokens_details?.cached_tokens ?? null,
      cache_creation_input_tokens: null,
    },
  };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

/** One model call through the OpenAI Responses API. */
export async function createOpenAIMessage(req: ModelRequest): Promise<ModelTurn> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) {
    throw new Error('LLM_PROVIDER=openai needs OPENAI_API_KEY');
  }
  const tools = toResponsesTools(req.tools);
  const body = {
    model: req.model,
    // `instructions` is the system prompt; it stays static per mode, so OpenAI's
    // automatic prefix caching holds just like Anthropic's cache_control did.
    instructions: req.system,
    input: toResponsesInput(req.messages),
    ...(tools.length > 0 ? { tools } : {}),
    max_output_tokens: req.maxTokens,
    ...(req.effort === 'none' ? {} : { reasoning: { effort: req.effort } }),
    store: false,
  };

  let lastErr: unknown;
  const attempts = 1 + (req.maxRetries ?? DEFAULT_RETRIES);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetch(`${cfg.OPENAI_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (res.ok) return fromResponsesOutput((await res.json()) as ResponsesBody);
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    lastErr = new Error(`OpenAI responses HTTP ${res.status}: ${detail}`);
    if (!RETRYABLE.has(res.status)) break;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
