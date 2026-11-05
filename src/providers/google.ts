import { ProviderError } from '../errors.js';
import type { CatalogModel } from '../catalog.js';
import type { ContentPart, Message, Provider } from '../types.js';
import { isRecord } from '../util.js';

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

/** The ids that are one general-availability Gemini text model: gemini-3.8-flash, gemini-2.5-flash-lite, gemini-3.1-pro. A preview, a dated copy, a speech, image, live, embedding or robotics model has a longer id and is not matched. */
const GA = /^gemini-(\d+(?:\.\d+)*)-(flash-lite|flash|pro)$/;

/** "flash", "flash-lite" or "pro" for a general-availability Gemini id, otherwise undefined. */
export const googleLine = (id: string): string | undefined => GA.exec(id)?.[2];

/** One entry of Google's model list as a CatalogModel. Google gives no lifecycle, retirement date or release date, so the line (flash, flash-lite, pro) and version come from the id, and only models that can generate text are kept. */
export function normalizeGoogle(r: unknown): CatalogModel | null {
  if (!isRecord(r) || typeof r.name !== 'string') return null;
  const id = r.name.replace(/^models\//, '');
  if (!id) return null;
  const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : [];
  if (!methods.includes('generateContent')) return null;
  const m = GA.exec(id);
  const context = typeof r.inputTokenLimit === 'number' && r.inputTokenLimit > 0 ? r.inputTokenLimit : undefined;
  return {
    id,
    publisher: 'google',
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    ...(context ? { context_length: context } : {}),
    ...(m ? { line: m[2], version: m[1] } : {}),
  };
}

/** Google's Gemini API directly, for use as a fallback with a separate key from OpenRouter. */
export function google(opts: GoogleOptions = {}): Provider {
  const f = opts.fetch ?? fetch;
  return {
    name: 'google',
    vision: true,
    lineOf: googleLine,
    async call(req) {
      const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': req.apiKey },
        body: JSON.stringify({
          ...(req.system ? { system_instruction: { parts: [{ text: req.system }] } } : {}),
          contents: req.messages.map(wire),
          generationConfig: { maxOutputTokens: req.maxTokens, ...(req.temperature === undefined ? {} : { temperature: req.temperature }) },
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
    /** What Google offers now. A model it no longer lists is treated as withdrawn. Google's list says nothing about lifecycle, so a model it still lists but has stopped serving is not noticed here: the call fails and the next fallback is tried. */
    async listModels(apiKey, signal) {
      const s = signal ?? AbortSignal.timeout(10_000);
      const out = new Map<string, CatalogModel>();
      let token = '';
      for (let page = 0; page < 5; page++) {
        const res = await f(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token}`, { headers: { 'x-goog-api-key': apiKey }, signal: s });
        if (!res.ok) return null;
        const body = (await res.json()) as { models?: unknown[]; nextPageToken?: string };
        for (const row of body.models ?? []) { const m = normalizeGoogle(row); if (m && !out.has(m.id)) out.set(m.id, m); }
        if (!body.nextPageToken) break;
        token = `&pageToken=${encodeURIComponent(body.nextPageToken)}`;
      }
      return out.size ? [...out.values()] : null;
    },
  };
}
