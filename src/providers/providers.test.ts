import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import { anthropic, normalizeAnthropic } from './anthropic.js';
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
  it('leaves the temperature out even when the call has one, because current Claude models reject it', async () => {
    const { seen, f } = capture({ content: [{ type: 'text', text: 'ok' }] });
    await anthropic({ fetch: f }).call({ ...base, temperature: 0.2, messages: [{ role: 'user', content: 'x' }] });
    expect(seen.body).not.toHaveProperty('temperature');
    expect(seen.body.max_tokens).toBe(100);
  });
  it('sends the temperature only when asked to, for an older model that still accepts one', async () => {
    const { seen, f } = capture({ content: [{ type: 'text', text: 'ok' }] });
    await anthropic({ fetch: f, sendTemperature: true }).call({ ...base, temperature: 0.2, messages: [{ role: 'user', content: 'x' }] });
    expect(seen.body.temperature).toBe(0.2);
    const none = capture({ content: [{ type: 'text', text: 'ok' }] });
    await anthropic({ fetch: none.f, sendTemperature: true }).call({ ...base, messages: [{ role: 'user', content: 'x' }] });
    expect(none.seen.body).not.toHaveProperty('temperature');   // nothing is invented when the call set none
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

describe('openrouter cost', () => {
  it('asks for the cost of the call and reports it with the usage', async () => {
    const { seen, f } = capture({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.00031 } });
    const r = await openrouter({ fetch: f }).call({ ...base, messages: [{ role: 'user', content: 'x' }] });
    expect(seen.body.usage).toEqual({ include: true });
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 120, costUsd: 0.00031 });
  });
  it('leaves the cost out when the provider does not give one', async () => {
    const { f } = capture({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 9, completion_tokens: 2 } });
    expect((await openrouter({ fetch: f }).call({ ...base, messages: [{ role: 'user', content: 'x' }] })).usage).toEqual({ inputTokens: 9, outputTokens: 2 });
  });
});

describe('openrouter reasoning per model', () => {
  it('sends the setting the caller chose for each model, and none where it says none', async () => {
    const reasoning = (m: string) => (m.startsWith('anthropic/') ? { enabled: false } : m.startsWith('google/') ? { effort: 'low', exclude: true } : null);
    const sent: Record<string, unknown> = {};
    const f = (async (_u: unknown, init: RequestInit) => { const b = JSON.parse(String(init.body)); sent[b.model] = b.reasoning; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); }) as typeof fetch;
    const p = openrouter({ fetch: f, reasoning });
    for (const model of ['anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash', 'mistralai/mistral-small']) await p.call({ ...base, model, messages: [{ role: 'user', content: 'x' }] });
    expect(sent['anthropic/claude-haiku-5.5']).toEqual({ enabled: false });
    expect(sent['google/gemini-3.8-flash']).toEqual({ effort: 'low', exclude: true });
    expect(sent['mistralai/mistral-small']).toBeUndefined();
  });
});

describe('anthropic model list', () => {
  const row = (id: string, o: Record<string, unknown> = {}) => ({ type: 'model', id, display_name: id, created_at: '2026-09-21T00:00:00Z', lifecycle: 'active', line: 'sonnet', retires_at: null, deprecated_at: null, max_input_tokens: 1_000_000, max_tokens: 64_000, capabilities: { image_input: { supported: true } }, ...o });
  /** Answers each request by its query string, and keeps the requests. */
  function lister(answers: Record<string, unknown | number>) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      const key = Object.keys(answers).find((k) => k && String(url).includes(k)) ?? '';
      const a = answers[key];
      return typeof a === 'number' ? new Response('no', { status: a }) : new Response(JSON.stringify(a), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, f };
  }

  it('turns a row into a catalogue entry: line, lifecycle, retirement date as the expiry, images, context', () => {
    expect(normalizeAnthropic(row('claude-sonnet-5-5', { lifecycle: 'deprecated', retires_at: '2026-11-30T00:00:00Z' }))).toEqual({
      id: 'claude-sonnet-5-5', publisher: 'anthropic', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      context_length: 1_000_000, lifecycle: 'deprecated', line: 'sonnet', created_at: '2026-09-21T00:00:00Z', expiration_date: '2026-11-30T00:00:00Z',
    });
    expect(normalizeAnthropic(row('x', { capabilities: {}, line: null, max_input_tokens: 0 }))).toMatchObject({ architecture: { input_modalities: ['text'] }, publisher: 'anthropic' });
    expect(normalizeAnthropic(row('x', { lifecycle: 'retired', retires_at: '2026-01-01T00:00:00Z' }))).not.toHaveProperty('expiration_date');
    expect(normalizeAnthropic({ nope: 1 })).toBeNull();
    expect(normalizeAnthropic('str')).toBeNull();
  });
  it('lists with the key in x-api-key, then asks for the retired ones too, and merges them', async () => {
    const { calls, f } = lister({ 'lifecycle=retired': { data: [row('claude-sonnet-4-20250514', { lifecycle: 'retired' })], has_more: false }, '': { data: [row('claude-sonnet-5-5')], has_more: false } });
    const models = await anthropic({ fetch: f }).listModels!('secret');
    expect(models?.map((m) => [m.id, m.lifecycle])).toEqual([['claude-sonnet-5-5', 'active'], ['claude-sonnet-4-20250514', 'retired']]);
    expect(calls[0].headers['x-api-key']).toBe('secret');
    expect(calls[0].url).toContain('limit=1000');
    expect(calls[1].url).toContain('lifecycle=retired');
  });
  it('follows pages', async () => {
    let n = 0;
    const f = (async () => new Response(JSON.stringify(n++ === 0 ? { data: [row('a')], has_more: true, last_id: 'a' } : { data: [row('b')], has_more: false }), { status: 200 })) as unknown as typeof fetch;
    const models = await anthropic({ fetch: f }).listModels!('k');
    expect(models?.map((m) => m.id)).toEqual(['a', 'b']);
  });
  it('keeps the live list when the retired read fails, and gives none when the live read fails', async () => {
    const ok = lister({ 'lifecycle=retired': 400, '': { data: [row('claude-sonnet-5-5')], has_more: false } });
    expect((await anthropic({ fetch: ok.f }).listModels!('k'))?.map((m) => m.id)).toEqual(['claude-sonnet-5-5']);
    const bad = lister({ '': 401 });
    expect(await anthropic({ fetch: bad.f }).listModels!('k')).toBeNull();
  });
});
