import type { KeyValueStore } from './types.js';

/** A store that lives in memory. The default; lost when the process ends. */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => { data.set(key, value); },
  };
}
