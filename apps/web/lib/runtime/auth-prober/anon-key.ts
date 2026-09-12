import { createHash } from 'node:crypto';
import { getProjectAnonKey, updateProjectAnonKey } from '@scanlyfix/db';
import { encryptValue, decryptValue } from '../../header-encryption.ts';
import { buildProbeUrl } from './probe';
import { PROBE_TIMEOUT_MS, PROBE_USER_AGENT } from './types';

export const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SAME_ORIGIN_SCRIPTS = 5;
export const CONTEXT_WINDOW_CHARS = 200;

const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const CONTEXT_SIGNALS = /(?:supabase|createClient|NEXT_PUBLIC_SUPABASE_ANON)/i;

/**
 * Computes a 16-hex-char SHA-256 fingerprint for display & logging.
 */
export function computeAnonKeyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Extracts Supabase anon-key candidates from HTML or JavaScript text.
 * Requires:
 * 1. Valid JWT structure (three dot-separated base64url segments starting with 'eyJ')
 * 2. Confidence scoring: Candidate must appear within ~200 chars of 'supabase',
 *    'createClient', or 'NEXT_PUBLIC_SUPABASE_ANON'.
 */
export function extractAnonKeyCandidates(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const candidates: string[] = [];
  const seen = new Set<string>();

  // Reset regex state
  JWT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = JWT_REGEX.exec(text)) !== null) {
    const key = match[0];
    const startIndex = match.index;
    const endIndex = startIndex + key.length;

    // Window ~200 characters before and after
    const windowStart = Math.max(0, startIndex - CONTEXT_WINDOW_CHARS);
    const windowEnd = Math.min(text.length, endIndex + CONTEXT_WINDOW_CHARS);
    const contextWindow = text.slice(windowStart, windowEnd);

    // Confidence scoring: must have >= 1 context signal
    if (CONTEXT_SIGNALS.test(contextWindow)) {
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(key);
      }
    }
  }

  return candidates;
}

/**
 * Checks if a script src is strictly same-origin (first-party) and NOT a third-party CDN.
 */
export function isSameOriginScript(src: string, hostname: string): boolean {
  if (!src || typeof src !== 'string') return false;

  const clean = src.trim();
  if (clean.startsWith('//')) {
    // Protocol-relative URL: //hostname/...
    const afterProtocol = clean.slice(2);
    const slashIdx = afterProtocol.indexOf('/');
    const host = slashIdx === -1 ? afterProtocol : afterProtocol.slice(0, slashIdx);
    return host.toLowerCase() === hostname.toLowerCase();
  }

  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    try {
      const parsed = new URL(clean);
      return parsed.hostname.toLowerCase() === hostname.toLowerCase();
    } catch {
      return false;
    }
  }

  // Relative paths like /_next/static/... or ./bundle.js are first-party
  if (clean.startsWith('/') || clean.startsWith('./') || !clean.includes(':')) {
    return true;
  }

  return false;
}

/**
 * Extracts same-origin first-party script URLs from HTML.
 * Bounded to max 5 files, 1-level deep.
 */
export function extractFirstPartyScriptUrls(html: string, hostname: string): string[] {
  const scriptSrcRegex = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const urls: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = scriptSrcRegex.exec(html)) !== null) {
    const src = match[1];
    if (src && isSameOriginScript(src, hostname)) {
      let normalizedPath = src;
      if (src.startsWith('http://') || src.startsWith('https://')) {
        try {
          const parsed = new URL(src);
          normalizedPath = parsed.pathname + parsed.search;
        } catch {
          continue;
        }
      } else if (src.startsWith('//')) {
        const slashIdx = src.indexOf('/', 2);
        normalizedPath = slashIdx !== -1 ? src.slice(slashIdx) : '/';
      }

      if (!normalizedPath.startsWith('/')) {
        normalizedPath = `/${normalizedPath}`;
      }

      if (!seen.has(normalizedPath)) {
        seen.add(normalizedPath);
        urls.push(normalizedPath);
        if (urls.length >= MAX_SAME_ORIGIN_SCRIPTS) {
          break;
        }
      }
    }
  }

  return urls;
}

/**
 * Extracts inline <script>...</script> contents from HTML.
 */
export function extractInlineScriptContents(html: string): string[] {
  const inlineRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
  const contents: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = inlineRegex.exec(html)) !== null) {
    const tag = match[0];
    // Ignore if it has a src attribute
    if (/\bsrc=["']/i.test(tag)) continue;
    const inner = match[1]?.trim();
    if (inner) {
      contents.push(inner);
    }
  }

  return contents;
}

/**
 * Discovers a Supabase anon key by fetching the homepage HTML and scanning
 * inline scripts and first-party JavaScript bundles.
 */
export async function discoverProjectAnonKey(hostname: string): Promise<string | null> {
  const homeUrl = buildProbeUrl(hostname, '/');
  if (!homeUrl) return null;

  try {
    const res = await fetch(homeUrl, {
      method: 'GET',
      headers: { 'user-agent': PROBE_USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!res.ok && res.status !== 200) return null;
    const html = await res.text();

    // 1. Check HTML and inline scripts
    const candidatesInHtml = extractAnonKeyCandidates(html);
    if (candidatesInHtml.length > 0 && candidatesInHtml[0]) {
      return candidatesInHtml[0];
    }

    const inlineScripts = extractInlineScriptContents(html);
    for (const inline of inlineScripts) {
      const candidates = extractAnonKeyCandidates(inline);
      if (candidates.length > 0 && candidates[0]) {
        return candidates[0];
      }
    }

    // 2. Fetch first-party script URLs (max 5 files, 1-level deep)
    const scriptUrls = extractFirstPartyScriptUrls(html, hostname);
    for (const scriptPath of scriptUrls) {
      const scriptUrl = buildProbeUrl(hostname, scriptPath);
      if (!scriptUrl) continue;

      try {
        const scriptRes = await fetch(scriptUrl, {
          method: 'GET',
          headers: { 'user-agent': PROBE_USER_AGENT },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          cache: 'no-store',
        });

        if (scriptRes.ok && scriptRes.status === 200) {
          const scriptContent = await scriptRes.text();
          const candidates = extractAnonKeyCandidates(scriptContent);
          if (candidates.length > 0 && candidates[0]) {
            return candidates[0];
          }
        }
      } catch {
        // Individual script fetch failure shouldn't stop checking remaining scripts
      }
    }

    return null;
  } catch {
    return null;
  }
}

export type AnonKeyInfo = {
  key: string;
  fingerprint: string;
};

/**
 * Retrieves the project's Supabase anon key with at-most-weekly refresh caching.
 * The key is encrypted at rest using the existing header-encryption helper.
 */
export async function getOrRefreshProjectAnonKey(
  projectId: string,
  hostname: string,
  options?: { forceRefresh?: boolean; now?: Date },
): Promise<AnonKeyInfo | null> {
  const now = options?.now ?? new Date();
  const cached = await getProjectAnonKey(projectId);

  // Check if refreshed recently (within 7 days)
  if (!options?.forceRefresh && cached?.anonKeyCheckedAt) {
    const elapsed = now.getTime() - new Date(cached.anonKeyCheckedAt).getTime();
    if (elapsed < WEEK_IN_MS) {
      if (cached.anonKeyEncrypted && cached.anonKeyFingerprint) {
        try {
          const key = decryptValue(cached.anonKeyEncrypted);
          return { key, fingerprint: cached.anonKeyFingerprint };
        } catch {
          // Decryption failed (corrupted or rotated master key) -> re-discover below
        }
      } else {
        // Checked this week and no anon key was detected
        return null;
      }
    }
  }

  // Discover key from the verified website
  const discoveredKey = await discoverProjectAnonKey(hostname);

  if (discoveredKey) {
    const fingerprint = computeAnonKeyFingerprint(discoveredKey);
    let encryptedKey: string | null = null;
    try {
      encryptedKey = encryptValue(discoveredKey);
    } catch {
      // If encryption key is not configured, still return in memory for non-persisted test runs
    }

    await updateProjectAnonKey(projectId, {
      anonKeyEncrypted: encryptedKey,
      anonKeyFingerprint: fingerprint,
      anonKeyCheckedAt: now,
    });

    return { key: discoveredKey, fingerprint };
  } else {
    await updateProjectAnonKey(projectId, {
      anonKeyEncrypted: null,
      anonKeyFingerprint: null,
      anonKeyCheckedAt: now,
    });
    return null;
  }
}
