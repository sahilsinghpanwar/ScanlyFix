import { PROBE_TIMEOUT_MS, PROBE_USER_AGENT, type ProbeOutcome } from './types';

export const SAFE_VALUES: Readonly<Record<string, string>> = {
  id: '1',
  postId: '1',
  email: 'test%40example.com',
  token: 'test',
  slug: 'test',
};

/**
 * Dynamic route parameter sanitizer.
 * Replaces route placeholders (e.g. [id], [postId], [email], [slug]) with safe test values.
 *
 * NOTE: Dynamic routes whose substituted ID does not exist on the target server
 * will return 404 Not Found. Under Auth Prober classification, 404 is evaluated as
 * 'inconclusive' and produces no finding. This is by design: probing unknown dynamic IDs
 * should never create false-positive auth alarms.
 */
export function sanitizeProbePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  return rawPath.replace(/\[([^\]]+)\]/g, (_match, paramName) => {
    return SAFE_VALUES[paramName] ?? 'test';
  });
}

/**
 * Validates whether a target path meets safety, SSRF, and formatting constraints.
 * Path must start with '/', not contain '..', not exceed 200 characters,
 * not exceed 200 characters after dynamic parameter substitution, and not contain whitespace.
 */
export function isValidProbePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  if (!path.startsWith('/') || path.includes('..') || path.length > 200) return false;
  if (/\s/.test(path)) return false;
  const concretePath = sanitizeProbePath(path);
  if (!concretePath || !concretePath.startsWith('/') || concretePath.length > 200) return false;
  return true;
}

/**
 * SSRF guard: hostname sirf verified DB value se aata hai, phir bhi
 * explicit allow-check — kyunki ye function real internet pe fire karta hai.
 */
export function buildProbeUrl(hostname: string, path: string): string | null {
  if (!isValidProbePath(path)) return null;
  const concretePath = sanitizeProbePath(path);
  if (concretePath.length > 200) return null;

  if (process.env.NODE_ENV !== 'production') {
    const isLocal =
      hostname === 'localhost' ||
      hostname.startsWith('localhost:') ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('127.0.0.1:');
    if (isLocal) {
      return `http://${hostname}${concretePath}`;
    }
  }

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname)) return null; // no localhost, no IPs, no ports
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return null;
  return `https://${hostname}${concretePath}`;
}

/**
 * Ek target ko logged-out visitor ki tarah probe karo.
 *
 * ⭐ redirect: 'manual' — iske bina 307→/login follow hota, login page ka
 *    200 dikhta, aur HAR protected route false-alarm karta. Ye line
 *    feature ko kaam karati hai.
 */
export async function probeTarget(hostname: string, path: string): Promise<ProbeOutcome> {
  const url = buildProbeUrl(hostname, path);
  if (!url) return { ok: false, error: 'invalid_target' };

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        'user-agent': PROBE_USER_AGENT,
        // Jaan-boojh ke koi cookie/auth header nahi — hum wahi logged-out stranger hain.
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Body drain karo (connection pool ke liye) par parse mat karo — v1 status-only hai.
    try {
      await res.arrayBuffer();
    } catch {
      /* body read fail ≠ probe fail */
    }
    return { ok: true, status: res.status };
  } catch (e) {
    // Timeout / DNS fail / app down → ye AUTH issue nahi hai. Error report karo, alarm nahi.
    return { ok: false, error: e instanceof Error ? e.message : 'network_error' };
  }
}

/**
 * Ek target ko public Supabase anon key ke sath probe karo.
 * Supabase RLS / anon-role leaks ko detect karta hai.
 */
export async function probeTargetWithAnonKey(
  hostname: string,
  path: string,
  anonKey: string,
): Promise<ProbeOutcome> {
  const url = buildProbeUrl(hostname, path);
  if (!url) return { ok: false, error: 'invalid_target' };

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        'user-agent': PROBE_USER_AGENT,
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    try {
      await res.arrayBuffer();
    } catch {
      /* body read fail ≠ probe fail */
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network_error' };
  }
}