import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import { anthropic } from './anthropic.js';
import { google } from './google.js';
import { openrouter } from './openrouter.js';

const png = 'data:image/png;base64,AAAA';
const base = { model: 'm', apiKey: 'secret', maxTokens: 100, signal: new AbortController().signal };

/** Captures the request a provider builds, and answers with a canned body. */
function capture(reply: unknown, status = 200) {
  const seen: { url: string; headers: Record<string, string>; body: any } = { url: '', headers: {}, body: null };
  const f = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.headers = init.headers as Record<string, string>;
    seen.body = JSON.parse(String(init.body));
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
  return { seen, f };
}

describe('openrouter adapter', () => {
  it('builds an OpenAI-style request, with the system prompt first and images as image_url', async () => {
    const { seen, f } = capture({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const r = await openrouter({ fetch: f }).call({ ...base, system: 'be brief', temperature: 0.3, messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'image', dataUrl: png }] }] });
    expect(seen.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen.headers.Authorization).toBe('Bearer secret');
    expect(seen.body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(seen.body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: png } });
    expect(seen.body.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(r).toEqual({ text: 'ok', usage: { inputTokens: 5, outputTokens: 2 } });
  });
  it('throws a ProviderError with the status and body on a failure', async () => {
    const { f } = capture('{"error":{"message":"no"}}', 429);
    await expect(openrouter({ fetch: f }).call({ ...base, messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ name: 'ProviderError', status: 429 });
  });
});

describe('anthropic adapter', () => {
  it('sends the key as x-api-key, the system prompt separately, and images as base64 blocks', async () => {
    const { seen, f } = capture({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'there' }], usage: { input_tokens: 7, output_tokens: 3 } });
    const r = await anthropic({ fetch: f }).call({ ...base, system: 'sys', messages: [{ role: 'user', content: [{ type: 'image', dataUrl: png }] }] });
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen.headers['x-api-key']).toBe('secret');
    expect(seen.body.system).toBe('sys');
    expect(seen.body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(seen.body).not.toHaveProperty('temperature');
    expect(r).toEqual({ text: 'hello there', usage: { inputTokens: 7, outputTokens: 3 } });
  });
  it('rejects an image that is not a base64 data URL before calling', async () => {
    const { f } = capture({});
    await expect(anthropic({ fetch: f }).call({ ...base, messages: [{ role: 'user', content: [{ type: 'image', dataUrl: 'https://x/y.png' }] }] })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('google adapter', () => {
  it('sends the key in a header (not the URL), calls the assistant "model", and reads usage', async () => {
    const { seen, f } = capture({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } });
    const r = await google({ fetch: f }).call({ ...base, model: 'gemini-x', system: 'sys', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
    expect(seen.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
    expect(seen.url).not.toContain('secret');
    expect(seen.headers['x-goog-api-key']).toBe('secret');
    expect(seen.body.system_instruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(seen.body.contents.map((c: any) => c.role)).toEqual(['user', 'model']);
    expect(r).toEqual({ text: 'ab', usage: { inputTokens: 4, outputTokens: 1 } });
  });
});
