import { ProviderError } from '../errors.js';
import type { ContentPart, Message, Provider } from '../types.js';

export interface GoogleOptions { fetch?: typeof fetch }

const IMAGE = /^data:(image\/[a-z+.-]+);base64,(.+)$/is;

function part(p: ContentPart) {
  if (p.type === 'text') return { text: p.text };
  const m = IMAGE.exec(p.dataUrl);
  if (!m) throw new ProviderError(400, 'image must be a base64 data URL');
  return { inlineData: { mimeType: m[1], data: m[2] } };
}
// Gemini has no assistant role: it calls it "model".
const wire = (m: Message) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(part) });

/** Google's Gemini API directly, for use as a fallback with a separate key from OpenRouter. */
export function google(opts: GoogleOptions = {}): Provider {
  const f = opts.fetch ?? fetch;
  return {
    name: 'google',
    vision: true,
    async call(req) {
      const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': req.apiKey },
        body: JSON.stringify({
          ...(req.system ? { system_instruction: { parts: [{ text: req.system }] } } : {}),
          contents: req.messages.map(wire),
          generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature },
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new ProviderError(res.status, await res.text());
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      return {
        text: (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
        usage: data.usageMetadata ? { inputTokens: data.usageMetadata.promptTokenCount ?? 0, outputTokens: data.usageMetadata.candidatesTokenCount ?? 0 } : undefined,
      };
    },
  };
}
