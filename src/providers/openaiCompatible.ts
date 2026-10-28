import type { CatalogModel } from '../catalog.js';
import { ProviderError } from '../errors.js';
import type { ContentPart, Message, Provider } from '../types.js';

/** Any service that speaks OpenAI's chat API: gateways (Requesty, LLM API), providers with free tiers
 *  (Groq, Cerebras), OpenAI and Mistral themselves, and local servers (Ollama). One adapter, with a
 *  preset for each service Lodestone has been checked against. Each preset also knows how to read that
 *  service's list of models, so Lodestone can drop a model that has gone and see its price and what it
 *  does with prompts. */

export interface OpenAICompatibleOptions {
  name: string;
  /** Up to and including /v1, with no trailing slash. */
  baseUrl: string;
  fetch?: typeof fetch;
  vision?: boolean;
  /** Extra headers (a referer, an organisation). */
  headers?: Record<string, string>;
  /** How much each model should think, as the service understands it; null to send nothing. */
  reasoning?: (model: string) => Record<string, unknown> | null;
  /** Reads one entry of the service's model list. Return null to skip it (not a chat model). Default: just the id. */
  normalize?: (raw: Record<string, unknown>) => CatalogModel | null;
}

const part = (p: ContentPart) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } });
const wire = (m: Message) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part) });

export function openaiCompatible(o: OpenAICompatibleOptions): Provider {
  const f = o.fetch ?? fetch;
  const norm = o.normalize ?? ((raw) => (typeof raw.id === 'string' ? { id: raw.id } : null));
  return {
    name: o.name,
    vision: o.vision ?? true,
    async call(req) {
      const reasoning = o.reasoning?.(req.model);
      const res = await f(`${o.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json', ...o.headers },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(reasoning ? { reasoning } : {}),
          messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages.map(wire)],
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError(res.status, await res.text());
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0, ...(typeof data.usage.cost === 'number' ? { costUsd: data.usage.cost } : {}) } : undefined,
      };
    },
    async listModels(apiKey, signal) {
      const res = await f(`${o.baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}`, ...o.headers }, signal: signal ?? AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: Record<string, unknown>[] } | Record<string, unknown>[];
      const rows = Array.isArray(body) ? body : body.data ?? [];
      const models = rows.map(norm).filter((m): m is CatalogModel => m !== null);
      return models.length ? models : null;
    },
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Requesty publishes, for every model, its price per token, the lab that made it, whether it is trained on and how long prompts are kept. */
export const normalizeRequesty = (r: Record<string, unknown>): CatalogModel | null => {
  if (typeof r.id !== 'string' || (r.api !== undefined && r.api !== 'chat')) return null;
  const inP = num(r.input_price); const outP = num(r.output_price);
  return {
    id: r.id,
    context_length: num(r.context_window),
    architecture: { input_modalities: r.supports_vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
    ...(inP !== undefined && outP !== undefined ? { pricing: { prompt: inP, completion: outP }, free: inP === 0 && outP === 0 } : {}),
    ...(str(r.model_lab) ? { publisher: str(r.model_lab)!.toLowerCase() } : {}),
    ...(typeof r.data_used_for_training === 'boolean' ? { data_used_for_training: r.data_used_for_training } : {}),
    ...(num(r.data_retention_days) !== undefined ? { data_retention_days: num(r.data_retention_days) } : {}),
  };
};

/** LLM API gives a model "family" (anthropic, gemini-flash, glm...): turned into the lab where that is clear. */
const labOf = (family: string): string => {
  const f = family.toLowerCase();
  return /gemini|gemma/.test(f) ? 'google' : /claude/.test(f) ? 'anthropic' : /^gpt|^o\d|openai/.test(f) ? 'openai' : /mistral|mixtral|codestral/.test(f) ? 'mistralai' : /llama/.test(f) ? 'meta-llama' : /grok/.test(f) ? 'x-ai' : f;
};

/** LLM API lists chat, image, video, speech and embedding models together: only "chat" is kept. */
export const normalizeLlmapi = (r: Record<string, unknown>): CatalogModel | null => {
  if (typeof r.id !== 'string' || r.kind !== 'chat') return null;
  const p = (r.pricing ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    context_length: num(r.context_length),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    ...(str(p.prompt) !== undefined && str(p.completion) !== undefined ? { pricing: { prompt: str(p.prompt), completion: str(p.completion) } } : {}),
    ...(r.free === true ? { free: true } : {}),
    ...(str(r.family) ? { publisher: labOf(str(r.family)!) } : {}),
  };
};

/** Groq lists speech, text-to-speech and safety-classifier models beside its chat models (seen 28 Oct 2026: whisper, orpheus, prompt-guard, safeguard). Those are not chat models, so they are left out. */
export const normalizeGroq = (r: Record<string, unknown>): CatalogModel | null => {
  if (typeof r.id !== 'string' || r.active === false || /whisper|orpheus|tts|guard|embed/i.test(r.id)) return null;
  return { id: r.id, ...(num(r.context_window) !== undefined ? { context_length: num(r.context_window) } : {}) };
};

export interface PresetOptions { fetch?: typeof fetch; headers?: Record<string, string>; reasoning?: OpenAICompatibleOptions['reasoning'] }

/** https://www.requesty.ai: a gateway to 800+ models, with failover between providers. `region: 'eu'` keeps prompts in the EU. */
export const requesty = (o: PresetOptions & { region?: 'eu' } = {}) =>
  openaiCompatible({ name: 'requesty', baseUrl: o.region === 'eu' ? 'https://router.eu.requesty.ai/v1' : 'https://router.requesty.ai/v1', normalize: normalizeRequesty, ...o });
/** https://llmapi.ai: a gateway to 150+ chat models. */
export const llmapi = (o: PresetOptions = {}) => openaiCompatible({ name: 'llmapi', baseUrl: 'https://api.llmapi.ai/v1', normalize: normalizeLlmapi, ...o });
/** https://groq.com: fast inference with a free developer tier. */
export const groq = (o: PresetOptions = {}) => openaiCompatible({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', normalize: normalizeGroq, ...o });
/** https://cerebras.ai: fast inference with a free tier. */
export const cerebras = (o: PresetOptions = {}) => openaiCompatible({ name: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', ...o });
export const openai = (o: PresetOptions = {}) => openaiCompatible({ name: 'openai', baseUrl: 'https://api.openai.com/v1', ...o });
export const mistral = (o: PresetOptions = {}) => openaiCompatible({ name: 'mistral', baseUrl: 'https://api.mistral.ai/v1', ...o });
export const together = (o: PresetOptions = {}) => openaiCompatible({ name: 'together', baseUrl: 'https://api.together.xyz/v1', ...o });
/** A local Ollama server: free, private, and nothing to go down. The key is ignored but must be non-empty. */
export const ollama = (o: PresetOptions & { baseUrl?: string } = {}) => openaiCompatible({ name: 'ollama', baseUrl: o.baseUrl ?? 'http://localhost:11434/v1', vision: false, ...o });
