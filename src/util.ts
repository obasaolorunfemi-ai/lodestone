/** The first `bytes` bytes of a SHA-256, in hex. Web Crypto exists in Node 20+, Workers, Deno and Bun. */
export async function sha256Hex(text: string, bytes = 16): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest.slice(0, bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Runs the functions it is given one at a time, so two calls in the same process cannot read the same
 *  counter and both write back. It does nothing for two processes: only an atomic store can do that. */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
