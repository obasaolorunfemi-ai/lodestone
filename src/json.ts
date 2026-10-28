/** Strips the ```json fences models like to wrap answers in, then parses. Returns
 *  undefined when it is not valid JSON. */
export function tryParseJson<T = unknown>(raw: string): T | undefined {
  const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try { return JSON.parse(cleaned) as T; } catch { return undefined; }
}
