import { PROBE_TIMEOUT_MS, PROBE_USER_AGENT, type ProbeOutcome } from './types';

export function sanitizeProbePath(rawPath: string): string {
  // If route is parameterized like /api/users/[id], replace placeholders with test values
  return rawPath
    .replace(/\[id\]/g, '1')
    .replace(/\[email\]/g, 'test@example.com')
    .replace(/\[token\]/g, 'test')
    .replace(/\[[^\]]+\]/g, 'test');
}

/**
 * SSRF guard: hostname sirf verified DB value se aata hai, phir bhi
 * explicit allow-check — kyunki ye function real internet pe fire karta hai.
 */
export function buildProbeUrl(hostname: string, path: string): string | null {
  if (!path.startsWith('/') || path.includes('..') || path.length > 200) return null;
  const concretePath = sanitizeProbePath(path);

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