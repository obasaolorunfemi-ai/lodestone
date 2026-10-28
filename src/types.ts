import type { CatalogModel } from './catalog.js';

export type Tier = 'fast' | 'strong' | 'vision';

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** What the provider charged for this call, in US dollars, when it says (OpenRouter does). */
  costUsd?: number;
}

/** What a provider adapter is asked to do: one model, one request. */
export interface ProviderRequest {
  model: string;
  system?: string;
  messages: Message[];
  maxTokens: number;
  /** Left out when the caller did not set one, so the provider's own default applies. */
  temperature?: number;
  apiKey: string;
  /** 'strict': the prompt must not be kept or used for training. A provider that can enforce it does (OpenRouter); the rest rely on Lodestone choosing only models whose list says so. */
  privacy?: 'strict';
  signal: AbortSignal;
}

export interface ProviderReply {
  text: string;
  usage?: Usage;
}

export interface Provider {
  name: string;
  /** Can this provider read images? */
  vision: boolean;
  call(req: ProviderRequest): Promise<ProviderReply>;
  /** The models the provider offers right now, with price and what it does with prompts where it says. Lets Lodestone drop a model that has gone and find others. */
  listModels?(apiKey: string, signal?: AbortSignal): Promise<CatalogModel[] | null>;
}

/** Where Lodestone keeps the model catalogue and cached answers. Anything that can
 *  get and set JSON by key will do: Netlify Blobs, Redis, a SQLite table, a Map. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
