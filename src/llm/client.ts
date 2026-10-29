import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type Config } from '../config.js';
import { createOpenAIMessage, type ReasoningEffort } from './openaiAssistant.js';
import { deepseekCreate, resolveFallback } from './deepseek.js';
import { tierOf } from './tier.js';

let client: Anthropic | undefined;

/**
 * The model client every call site uses. On LLM_PROVIDER=openai it is a shim
 * with the same `messages.create` surface that translates to the OpenAI
 * Responses API (see openaiAssistant.ts); on deepseek the request is cleaned for
 * DeepSeek's Anthropic-compatible endpoint (see deepseek.ts). No caller knows
 * which vendor runs it.
 */
export function getAnthropic(): Anthropic {
  if (client) return client;
  const cfg = loadConfig();
  if (cfg.LLM_PROVIDER === 'openai') {
    client = openaiShim();
    return client;
  }
  if (cfg.LLM_PROVIDER === 'deepseek') {
    client = deepseekShim(cfg);
    return client;
  }
  client = anthropicClient(cfg);
  return client;
}

function anthropicClient(cfg: Config): Anthropic {
  // The SDK retries transient failures (429, 5xx incl. 529 "Overloaded") with
  // exponential backoff + jitter and respects retry-after. Bump from the
  // default 2 so brief overloads don't surface as a user-facing error.
  return new Anthropic({
    apiKey: cfg.ANTHROPIC_API_KEY,
    maxRetries: 5,
    timeout: 120_000,
  });
}

/**
 * LLM_PROVIDER=deepseek: the same SDK pointed at DeepSeek's Anthropic-compatible
 * endpoint, wrapped by the request cleaner in deepseek.ts; photos/PDFs and
 * outages go to the DEEPSEEK_FALLBACK vendor with the caller's request untouched.
 */
function deepseekShim(cfg: Config): Anthropic {
  const ds = new Anthropic({
    apiKey: cfg.DEEPSEEK_API_KEY,
    baseURL: `${cfg.DEEPSEEK_BASE_URL}/anthropic`,
    // Fewer than Claude's 5: a dead DeepSeek should reach the fallback quickly.
    maxRetries: 2,
    timeout: 120_000,
  });
  const kind = resolveFallback(cfg);
  const fallback =
    kind === 'anthropic' ? anthropicClient(cfg) : kind === 'openai' ? openaiShim() : null;
  const create = deepseekCreate({
    deepseek: (params, opts) => ds.messages.create(params, opts),
    fallback: fallback ? (params, opts) => fallback.messages.create(params, opts) as Promise<Anthropic.Message> : null,
  });
  return { messages: { create } } as unknown as Anthropic;
}

export interface OpenAITier {
  model: string;
  effort: ReasoningEffort;
}

/**
 * Which OpenAI model stands in for an Anthropic model id. Callers name their
 * model by TIER through config (ANTHROPIC_MODEL = the dialogue, the precise/
 * calendar model = the precise tier, every ANTHROPIC_*_MODEL hidden pass = the
 * cheap tier), so the tier is read back off which config value was passed:
 * dialogue → SOL, precise → ASTRA, anything else → LUNA. Pure, for tests.
 */
export function openaiTierFor(model: string, cfg: Config): OpenAITier {
  const tier = tierOf(model, cfg);
  if (tier === 'dialogue') {
    return { model: cfg.OPENAI_ASSISTANT_MODEL, effort: cfg.OPENAI_ASSISTANT_EFFORT };
  }
  if (tier === 'precise') {
    return { model: cfg.OPENAI_PRECISE_MODEL, effort: cfg.OPENAI_PRECISE_EFFORT };
  }
  return { model: cfg.OPENAI_CHEAP_MODEL, effort: cfg.OPENAI_CHEAP_EFFORT };
}

function systemText(system: Anthropic.MessageCreateParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

function openaiShim(): Anthropic {
  const create = async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    opts?: { timeout?: number; maxRetries?: number },
  ) => {
    const cfg = loadConfig();
    const tier = openaiTierFor(params.model, cfg);
    // Anthropic-only knobs (thinking, temperature, output_config, cache_control)
    // are simply not forwarded: reasoning depth comes from the tier's effort.
    return createOpenAIMessage({
      model: tier.model,
      effort: tier.effort,
      maxTokens: params.max_tokens,
      system: systemText(params.system),
      tools: params.tools ?? [],
      messages: params.messages,
      ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
      ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    });
  };
  return { messages: { create } } as unknown as Anthropic;
}
