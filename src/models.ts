import type { Tier } from './types.js';

/** Starting preferences, tried in order. They are only preferences: Lodestone checks
 *  them against OpenRouter's catalogue and replaces any that have been withdrawn, so
 *  these going out of date is expected and harmless. Override per tier in the config.
 *  Every free list ends with `openrouter/free`, OpenRouter's own router, which picks
 *  whichever free model is available at that moment. */
export const DEFAULT_MODELS: Record<Tier, string[]> = {
  fast: ['google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3.5-lightning:free', 'openrouter/free'],
  strong: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'openrouter/free'],
  vision: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3.5-super-vl:free', 'openrouter/free'],
};

/** Tried only when paid use is allowed (a person's own key, or `allowPaid`) and the
 *  free models failed. Fractions of a cent per request; with no credit OpenRouter
 *  refuses and nothing is spent. */
export const DEFAULT_PAID_MODELS = ['qwen/qwen3.7-flash', 'mistralai/mistral-small-3.2-24b-instruct'];
