import type { Provider, ProviderReply, ProviderRequest } from '../types.js';

/** A provider that answers without any network, for tests and offline development.
 *  Pass a function to control the answer, or throw from it to simulate a failure. */
export function mock(reply: string | ((req: ProviderRequest) => ProviderReply | string | Promise<ProviderReply | string>) = '[mock answer]'): Provider & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  return {
    name: 'mock',
    vision: true,
    calls,
    async call(req) {
      calls.push(req);
      const r = typeof reply === 'function' ? await reply(req) : reply;
      return typeof r === 'string' ? { text: r } : r;
    },
  };
}
