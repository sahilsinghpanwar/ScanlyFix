/*
Minimal typed PostgREST client — does NOT depend on supabase-js
(keeps the SDK zero-dependency).
Only these 4 operations are required: schema read (OpenAPI), select, rpc, and head-count.
*/

export type RestConfig = { url: string; serviceKey: string; anonKey?: string | null };

export type RestResult<T> = { status: number; ok: boolean; data: T | null; count: number | null };

function headers(cfg: RestConfig, key: 'service' | 'anon', extra: Record<string, string> = {}): Record<string, string> {
  const k = key === 'anon' ? cfg.anonKey : cfg.serviceKey;
  return {
    apikey: k ?? '',
    authorization: `Bearer ${k ?? ''}`,
    'content-type': 'application/json',
    ...extra,
  };
}

export async function restSelect<T>(
  cfg: RestConfig,
  table: string,
  opts: { query?: string; key?: 'service' | 'anon'; limit?: number; withCount?: boolean } = {},
): Promise<RestResult<T[]>> {
  const extra: Record<string, string> = {};
  if (opts.withCount) extra.prefer = 'count=exact';
  const q = [opts.query, opts.limit ? `limit=${opts.limit}` : null].filter(Boolean).join('&');
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/${table}${q ? `?${q}` : ''}`, {
      method: 'GET',
      headers: headers(cfg, opts.key ?? 'service', extra),
      signal: AbortSignal.timeout(10_000),
    });
    const countHeader = res.headers.get('content-range');
    const count = countHeader ? Number(countHeader.split('/')[1]) : null;
    const data = res.status === 200 ? ((await res.json()) as T[]) : null;
    return { status: res.status, ok: res.ok, data, count: Number.isFinite(count) ? count : null };
  } catch {
    return { status: 0, ok: false, data: null, count: null };
  }
}

export async function restRpc<T>(cfg: RestConfig, fn: string, body: unknown): Promise<RestResult<T>> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: headers(cfg, 'service'),
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    const data = res.ok ? ((await res.json()) as T) : null;
    return { status: res.status, ok: res.ok, data, count: null };
  } catch {
    return { status: 0, ok: false, data: null, count: null };
  }
}

/** OpenAPI definitions → table names (schema read — "read your schema"). */
export async function listTableNames(cfg: RestConfig): Promise<string[] | null> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/`, {
      headers: headers(cfg, 'service'),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const spec = (await res.json()) as { definitions?: Record<string, unknown> };
    return spec.definitions ? Object.keys(spec.definitions) : null;
  } catch {
    return null;
  }
}

/** Validation — Prevent SSRF or malformed/invalid requests from reaching the REST client. */
export function isValidSupabaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /^[\w-]+\.supabase\.(co|in|red)$/.test(u.hostname);
  } catch {
    return false;
  }
}