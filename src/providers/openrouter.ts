import { ProviderError } from '../errors.js';
import type { ContentPart, Message, Provider } from '../types.js';

export interface OpenRouterOptions {
  fetch?: typeof fetch;
  /** Ask the model not to think at length. Default true: most tasks need an answer, not a long chain of thought, and thinking is what made some free models slower than the time allowed. */
  lowReasoning?: boolean;
  /** Sent as HTTP-Referer and X-Title, which OpenRouter uses to credit apps. */
  referer?: string;
  title?: string;
}

const part = (p: ContentPart) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } });
const wire = (m: Message) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part) });

export function openrouter(opts: OpenRouterOptions = {}): Provider {
  const f = opts.fetch ?? fetch;
  return {
    name: 'openrouter',
    vision: true,
    async call(req) {
      const res = await f('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          'Content-Type': 'application/json',
          ...(opts.referer ? { 'HTTP-Referer': opts.referer } : {}),
          ...(opts.title ? { 'X-Title': opts.title } : {}),
        },
        body: JSON.stringify({
          model: req.model,
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          max_tokens: req.maxTokens,
          ...(opts.lowReasoning === false ? {} : { reasoning: { effort: 'low', exclude: true } }),
          messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages.map(wire)],
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError(res.status, await res.text());
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } : undefined,
      };
    },
  };
}
