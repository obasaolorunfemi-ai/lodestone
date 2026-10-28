// Redundancy: OpenRouter first, then two other gateways and a free tier, each with its own key, so one
// provider's outage does not take the tool down. Discovery keeps each list alive and keeps it short.
import { createLodestone, groq, llmapi, requesty } from '@extrafemi-ai/lodestone';

const CHEAP = { maxPromptUsdPerMTok: 1, maxCompletionUsdPerMTok: 5 };

export const ai = createLodestone({
  openrouter: { apiKey: process.env.OPENROUTER_API_KEY, allowPaid: true, paidFirst: true, paidModels: ['anthropic/claude-haiku-5.5'] },
  fallbacks: [
    // Model ids are each gateway's own. Models a gateway stops listing are dropped, and if the list is short it is
    // topped up (never above 3) with trusted-lab models under the price limit.
    { provider: requesty(), apiKey: process.env.REQUESTY_API_KEY ?? '', models: ['bedrock/claude-haiku-5-5', 'vertex/gemini-3.8-flash'], discover: { fill: CHEAP, max: 3 } },
    { provider: llmapi(), apiKey: process.env.LLMAPI_API_KEY ?? '', models: ['claude-haiku-5-5', 'gemini-3.8-flash'], discover: { fill: CHEAP, max: 3 } },
    // A free tier costs nothing, so it is never counted against a spend limit.
    { provider: groq(), apiKey: process.env.GROQ_API_KEY ?? '', models: ['llama-3.3-70b-versatile'], free: true },
  ], // a fallback with no key is skipped, so only the ones you have keys for are used
  trust: {
    requireNoTraining: true,   // refuse a model its provider says is trained on (Requesty publishes this for every model)
    maxRetentionDays: 30,
    block: [],                 // exact model ids, or a lab followed by a slash
  },
});

// For something sensitive, like a CV: OpenRouter is told to use only providers that do not keep or train on it,
// and other models are used only if their provider's list says the same.
export const summariseCv = (cv: string) => ai.json({ prompt: `Summarise:\n${cv}`, private: true });
