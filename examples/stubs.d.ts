// Just enough of the Netlify packages for the examples to be type-checked here without installing them.
declare module '@netlify/blobs' {
  export function getStore(name: string): { get(key: string, opts: { type: 'json' }): Promise<unknown>; setJSON(key: string, value: unknown): Promise<void> };
}
declare module '@netlify/functions' {
  export type Handler = (event: { httpMethod: string; headers: Record<string, string | undefined>; body: string | null }) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;
}
