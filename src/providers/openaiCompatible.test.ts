import { describe, expect, it } from 'vitest';
import { cerebras, omniakey, groq, llmapi, mistral, normalizeGroq, normalizeLlmapi, normalizeRequesty, ollama, openai, openaiCompatible, requesty, together } from './openaiCompatible.js';
import { ProviderError } from '../errors.js';

const base = { model: 'm', apiKey: 'secret', maxTokens: 100, signal: new AbortController().signal };
function capture(reply: unknown, status = 200) {
  const seen: { url: string; headers: Record<string, string>; body: any } = { url: '', headers: {}, body: null };
  const f = (async (url: string, init: RequestInit) => { seen.url = String(url); seen.headers = init.headers as Record<string, string>; seen.body = init.body ? JSON.parse(String(init.body)) : null; return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status }); }) as unknown as typeof fetch;
  return { seen, f };
}

// Rows shaped like the real model lists (Requesty and LLM API, 28 Oct 2026).
const requestyRows = [
  { id: 'vertex/gemini-3.8-flash', api: 'chat', model_lab: 'Google', input_price: 3e-7, output_price: 2.5e-6, context_window: 1_000_000, supports_vision: true, data_used_for_training: false, data_retention_days: 0 },
  { id: 'openai/gpt-6.1-terra:flex', api: 'chat', model_lab: 'openai', input_price: 0, output_price: 0, context_window: 400_000, supports_vision: false, data_used_for_training: true, data_retention_days: 30 },
  { id: 'x/embedder', api: 'embedding', input_price: 1e-7, output_price: 0 },
];
const llmapiRows = [
  { id: 'claude-fable-5-1', kind: 'chat', family: 'anthropic', context_length: 500_000, pricing: { prompt: '0.000001', completion: '0.000005' }, free: false },
  { id: 'gemini-3.8-flash', kind: 'chat', family: 'gemini-flash', context_length: 1_000_000, pricing: { prompt: '0.00000075', completion: '0.00000375' } },
  { id: 'MiniMax-M3.1-Flash', kind: 'chat', family: 'minimax', context_length: 1_000_000, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
  { id: 'azure/text-embedding-3-large', kind: 'embedding' },
  { id: 'some-video-model', kind: 'video' },
  { id: 'unlabelled-model' },
];

describe('openaiCompatible: calling', () => {
  it('posts to the base URL with a bearer key, the system prompt first, and returns the text and usage', async () => {
    const { seen, f } = capture({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 9, completion_tokens: 2, cost: 0.0001 } });
    const r = await openaiCompatible({ name: 'x', baseUrl: 'https://gw.example/v1', fetch: f }).call({ ...base, system: 'be brief', temperature: 0.3, messages: [{ role: 'user', content: 'q' }] });
    expect(seen.url).toBe('https://gw.example/v1/chat/completions');
    expect(seen.headers.Authorization).toBe('Bearer secret');
    expect(seen.body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(seen.body.temperature).toBe(0.3);
    expect(r).toEqual({ text: 'hi', usage: { inputTokens: 9, outputTokens: 2, costUsd: 0.0001 } });
  });
  it('leaves out temperature and reasoning unless set, and sends images as image_url', async () => {
    const { seen, f } = capture({ choices: [{ message: { content: 'ok' } }] });
    await openaiCompatible({ name: 'x', baseUrl: 'https://gw/v1', fetch: f }).call({ ...base, messages: [{ role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA' }] }] });
    expect(seen.body).not.toHaveProperty('temperature');
    expect(seen.body).not.toHaveProperty('reasoning');
    expect(seen.body.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } });
  });
  it('throws a ProviderError carrying the status and body on a failure', async () => {
    const { f } = capture('{"error":{"message":"nope"}}', 429);
    await expect(openaiCompatible({ name: 'x', baseUrl: 'https://gw/v1', fetch: f }).call({ ...base, messages: [{ role: 'user', content: 'q' }] })).rejects.toMatchObject({ name: 'ProviderError', status: 429 });
    expect(new ProviderError(500, 'x').status).toBe(500);
  });
});

describe('openaiCompatible: listing models', () => {
  it("reads Requesty's list: chat models only, the lab, price, and what happens to prompts", async () => {
    const { f, seen } = capture({ data: requestyRows });
    const list = (await requesty({ fetch: f }).listModels!('k'))!;
    expect(seen.url).toBe('https://router.requesty.ai/v1/models');
    expect(list.map((x) => x.id)).toEqual(['vertex/gemini-3.8-flash', 'openai/gpt-6.1-terra:flex']);
    expect(list[0]).toMatchObject({ publisher: 'google', data_used_for_training: false, data_retention_days: 0, context_length: 1_000_000, pricing: { prompt: 3e-7, completion: 2.5e-6 }, free: false });
    expect(list[0].architecture?.input_modalities).toContain('image');
    expect(list[1]).toMatchObject({ data_used_for_training: true, data_retention_days: 30, free: true });
  });
  it("reads LLM API's list: chat models only, with price, and ignores video, image and embedding models", async () => {
    const { f } = capture({ data: llmapiRows });
    const list = (await llmapi({ fetch: f }).listModels!('k'))!;
    expect(list.map((x) => x.id)).toEqual(['claude-fable-5-1', 'gemini-3.8-flash', 'MiniMax-M3.1-Flash']);
    expect(list[1].publisher).toBe('google'); // the family "gemini-flash" is Google's
    expect(list[0]).toMatchObject({ publisher: 'anthropic', pricing: { prompt: '0.000001', completion: '0.000005' } });
  });
  it('reads a plain OpenAI-style list with only ids, and returns null when the list cannot be read', async () => {
    expect((await groq({ fetch: capture({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }] }).f }).listModels!('k'))?.map((x) => x.id)).toEqual(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
    expect(await groq({ fetch: capture('{}', 401).f }).listModels!('bad')).toBeNull();
    expect(await groq({ fetch: capture({ data: [] }).f }).listModels!('k')).toBeNull();
  });
  it('normalizers skip rows that are not chat models or have no id', () => {
    expect(normalizeRequesty({ api: 'chat' })).toBeNull();
    expect(normalizeLlmapi({ id: 'x', kind: 'image' })).toBeNull();
  });
});

describe('presets', () => {
  it('point at the documented endpoints', () => {
    const urls = async (p: ReturnType<typeof groq>) => { const { f, seen } = capture({ data: [{ id: 'm' }] }); const q = p; await q.listModels!('k'); void f; return seen.url; };
    const check = async (make: (o: { fetch: typeof fetch }) => ReturnType<typeof groq>, expected: string) => { const { f, seen } = capture({ data: [{ id: 'm' }] }); await make({ fetch: f }).listModels!('k'); expect(seen.url).toBe(expected); };
    void urls;
    return Promise.all([
      check(requesty, 'https://router.requesty.ai/v1/models'),
      check((o) => requesty({ ...o, region: 'eu' }), 'https://router.eu.requesty.ai/v1/models'),
      check(llmapi, 'https://api.llmapi.ai/v1/models'),
      check(groq, 'https://api.groq.com/openai/v1/models'),
      check(cerebras, 'https://api.cerebras.ai/v1/models'),
      check(omniakey, 'https://api.omniakey.com/v1/models'),
      check(openai, 'https://api.openai.com/v1/models'),
      check(mistral, 'https://api.mistral.ai/v1/models'),
      check(together, 'https://api.together.xyz/v1/models'),
      check(ollama, 'http://localhost:11434/v1/models'),
    ]);
  });
  it('are named for the service, so a failure can say which one', () => {
    expect([requesty(), llmapi(), groq(), cerebras(), omniakey(), openai(), mistral(), together(), ollama()].map((p) => p.name)).toEqual(['requesty', 'llmapi', 'groq', 'cerebras', 'omniakey', 'openai', 'mistral', 'together', 'ollama']);
  });
});

describe('normalizeGroq', () => {
  it('keeps chat models and leaves out speech, text-to-speech and safety classifiers', () => {
    const ids = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'allam-2-7b', 'whisper-large-v3', 'canopylabs/orpheus-v1-english', 'meta-llama/llama-prompt-guard-2-22m', 'openai/gpt-oss-safeguard-20b'];
    expect(ids.map((id) => normalizeGroq({ id })?.id ?? null)).toEqual(['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'allam-2-7b', null, null, null, null]);
    expect(normalizeGroq({ id: 'x', active: false })).toBeNull();
  });
});
