export type Tier = 'fast' | 'strong' | 'vision';

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
}

/** Where Lodestone keeps the model catalogue and cached answers. Anything that can
 *  get and set JSON by key will do: Netlify Blobs, Redis, a SQLite table, a Map. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
