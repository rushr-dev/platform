/** A Rushr API error, with the API's own `code` passed straight through (e.g. `honeypot`, `unsafe_token`). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface ApiOptions {
  baseUrl: string;
  /** Returns the current rk_ key, if any (it can appear mid-session after `register`). */
  apiKey?: () => string | undefined;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Waits on 429, at most this long per retry (seconds). */
  maxRetryWait?: number;
}

export type Api = <T = unknown>(method: string, path: string, opts?: { body?: unknown; auth?: boolean; query?: Record<string, string | number | undefined> }) => Promise<T>;

/**
 * Minimal JSON client for https://api.rushr.trade (llms.txt). Retries 429 twice, honouring Retry-After.
 * Never logs request bodies.
 */
export function createApi(o: ApiOptions): Api {
  const f = o.fetch ?? fetch;
  const ua = o.userAgent ?? 'rushr-mcp';
  return async function api<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': ua };
    if (opts.auth !== false) {
      const key = o.apiKey?.();
      if (key) headers.authorization = `Bearer ${key}`;
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let url = o.baseUrl + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    for (let attempt = 0; ; attempt++) {
      const r = await f(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      const text = await r.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const e = (json as { error?: unknown } | null)?.error as { code?: unknown; message?: unknown; retryAfter?: unknown } | string | undefined;
      if (r.status === 429 && attempt < 2) {
        const wait = Math.min(Number(r.headers.get('retry-after') ?? (typeof e === 'object' ? e.retryAfter : undefined) ?? 10) || 10, o.maxRetryWait ?? 30);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      if (!r.ok) {
        const code = typeof e === 'object' && e ? String(e.code ?? 'http_error') : r.status === 404 ? 'not_found' : 'http_error';
        const message = typeof e === 'object' && e ? String(e.message ?? '') : typeof e === 'string' ? e : text.slice(0, 200);
        throw new ApiError(r.status, code, message || `HTTP ${r.status}`, json);
      }
      return json as T;
    }
  };
}
