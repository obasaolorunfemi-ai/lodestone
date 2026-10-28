import { ProviderError } from '../errors.js';
import type { ContentPart, Message, Provider } from '../types.js';

export interface AnthropicOptions { fetch?: typeof fetch }

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
  return {
    name: 'anthropic',
    vision: true,
    async call(req) {
      const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
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
  };
}
