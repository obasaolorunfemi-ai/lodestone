import { ProviderError } from '../errors.js';
import type { CatalogModel } from '../catalog.js';
import type { ContentPart, Message, Provider } from '../types.js';
import { isRecord } from '../util.js';

export interface AnthropicOptions {
  fetch?: typeof fetch;
  /** Send the request's temperature. Default false. Anthropic's current models reject a temperature: Claude 4.7 and later answer 400 to a non-default one, and API version 2026-10-21 removes the parameter for every model. Lodestone's calls default to 0.2, so by default it is left out and the model's own setting applies. Turn this on only for an older model that still accepts one. */
  sendTemperature?: boolean;
}

const VERSION = '2023-06-01';
const LIFECYCLES = ['active', 'deprecated', 'retired'] as const;
const string = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** One row of Anthropic's model list as a CatalogModel. The retirement date becomes `expiration_date`, so a model about to go is left out like any other. */
export function normalizeAnthropic(r: unknown): CatalogModel | null {
  if (!isRecord(r) || typeof r.id !== 'string' || !r.id) return null;
  const caps = isRecord(r.capabilities) ? r.capabilities : {};
  const image = isRecord(caps.image_input) && caps.image_input.supported === true;
  const lifecycle = LIFECYCLES.find((l) => l === r.lifecycle);
  const retires = lifecycle === 'retired' ? undefined : string(r.retires_at);
  const context = typeof r.max_input_tokens === 'number' && r.max_input_tokens > 0 ? r.max_input_tokens : undefined;
  return {
    id: r.id,
    publisher: 'anthropic',
    architecture: { input_modalities: image ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
    ...(context ? { context_length: context } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(string(r.line) ? { line: string(r.line) } : {}),
    ...(string(r.created_at) ? { created_at: string(r.created_at) } : {}),
    ...(retires ? { expiration_date: retires } : {}),
  };
}

const IMAGE = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s;

function part(p: ContentPart) {
  if (p.type === 'text') return { type: 'text', text: p.text };
  const m = IMAGE.exec(p.dataUrl);
  if (!m) throw new ProviderError(400, 'image must be a base64 data URL (jpeg, png, gif or webp)');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}
const wire = (m: Message) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part) });

/** Anthropic's own API, for use as a fallback with a separate key from OpenRouter. */
export function anthropic(opts: AnthropicOptions = {}): Provider {
  const f = opts.fetch ?? fetch;

  /** Every page of the list for one query, newest first; null if the list cannot be read. */
  async function pages(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[] | null> {
    const rows: unknown[] = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      const res = await f(`https://api.anthropic.com/v1/models?limit=1000${query}${after}`, { headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION }, signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown[]; has_more?: boolean; last_id?: string | null };
      rows.push(...(body.data ?? []));
      if (!body.has_more || !body.last_id) break;
      after = `&after_id=${encodeURIComponent(body.last_id)}`;
    }
    return rows;
  }

  return {
    name: 'anthropic',
    vision: true,
    async call(req) {
      const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': req.apiKey, 'anthropic-version': VERSION },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(opts.sendTemperature && req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.system ? { system: req.system } : {}),
          messages: req.messages.map(wire),
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError(res.status, await res.text());
      const data = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      return {
        text: (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
        usage: data.usage ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 } : undefined,
      };
    },
    /** What Anthropic offers now. The default list has the active and deprecated models, so a retired id is simply missing; a second read asks for the retired ones too, so Lodestone can tell which line a retired id belonged to. If that second read fails, the first still stands. */
    async listModels(apiKey, signal) {
      const s = signal ?? AbortSignal.timeout(10_000);
      const live = await pages('', apiKey, s);
      if (!live) return null;
      const retired = await pages('&lifecycle=retired', apiKey, s).catch(() => null);
      const out = new Map<string, CatalogModel>();
      for (const row of [...live, ...(retired ?? [])]) { const m = normalizeAnthropic(row); if (m && !out.has(m.id)) out.set(m.id, m); }
      return out.size ? [...out.values()] : null;
    },
  };
}
