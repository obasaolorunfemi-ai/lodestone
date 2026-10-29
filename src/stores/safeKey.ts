import { sha256Hex } from '../util.js';

/** A key every store accepts: letters, digits, dot, dash and underscore stay as they are, anything else becomes ~ and two hex digits
 *  (so the same key always gives the same result, and two different keys never give the same one). A key too long for a store is replaced by its hash. */
export async function safeKey(key: string, max = 200): Promise<string> {
  let out = '';
  for (const b of new TextEncoder().encode(key)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9._-]/.test(c) ? c : `~${b.toString(16).padStart(2, '0')}`;
  }
  return out.length <= max ? out : `h-${await sha256Hex(key, 32)}`;
}

/** For stores with no expiry of their own: a value wrapped with the time it stops being good. A value written by something else is passed through. */
export const wrap = (v: unknown, ttlMs: number | undefined, now: number) => ({ __lodestone: 1, v, ...(ttlMs ? { exp: now + ttlMs } : {}) });
export function unwrap(raw: unknown, now: number): unknown {
  if (typeof raw === 'object' && raw !== null && (raw as { __lodestone?: unknown }).__lodestone === 1) {
    const { v, exp } = raw as { v: unknown; exp?: number };
    return typeof exp === 'number' && exp <= now ? null : v ?? null;
  }
  return raw ?? null;
}
