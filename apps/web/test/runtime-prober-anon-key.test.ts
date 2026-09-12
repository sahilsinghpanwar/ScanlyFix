import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getProjectAnonKeyMock = vi.fn();
const updateProjectAnonKeyMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  getProjectAnonKey: (...args: unknown[]) => getProjectAnonKeyMock(...args),
  updateProjectAnonKey: (...args: unknown[]) => updateProjectAnonKeyMock(...args),
}));

import {
  computeAnonKeyFingerprint,
  extractAnonKeyCandidates,
  extractFirstPartyScriptUrls,
  extractInlineScriptContents,
  getOrRefreshProjectAnonKey,
  isSameOriginScript,
  MAX_SAME_ORIGIN_SCRIPTS,
  WEEK_IN_MS,
} from '../lib/runtime/auth-prober/anon-key.ts';
import { encryptValue } from '../lib/header-encryption.ts';

const VALID_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM0NTY3ODl9.S3NyFp93B9hYV1X9M8X9-test-signature';

const UNRELATED_JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.signature-of-unrelated-jwt';

describe('auth prober — Supabase anon key extraction & caching', () => {
  const originalEnv = process.env.HEADER_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HEADER_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  afterEach(() => {
    process.env.HEADER_ENCRYPTION_KEY = originalEnv;
    vi.restoreAllMocks();
  });

  describe('extractAnonKeyCandidates heuristic', () => {
    it('extracts JWT appearing near createClient', () => {
      const html = `
        <script>
          const client = createClient("https://xyz.supabase.co", "${VALID_JWT}");
        </script>
      `;
      const candidates = extractAnonKeyCandidates(html);
      expect(candidates).toEqual([VALID_JWT]);
    });

    it('extracts JWT appearing near NEXT_PUBLIC_SUPABASE_ANON', () => {
      const js = `
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "${VALID_JWT}";
      `;
      const candidates = extractAnonKeyCandidates(js);
      expect(candidates).toEqual([VALID_JWT]);
    });

    it('extracts JWT appearing near supabase keyword', () => {
      const text = `
        /* supabase config initialization */
        window.__ENV = { SUPABASE_KEY: "${VALID_JWT}" };
      `;
      const candidates = extractAnonKeyCandidates(text);
      expect(candidates).toEqual([VALID_JWT]);
    });

    it('rejects valid JWT when no context signal appears within ~200 chars', () => {
      const padding = 'x'.repeat(250);
      const text = `
        createClient("https://xyz.supabase.co");
        ${padding}
        const unrelatedToken = "${UNRELATED_JWT}";
      `;
      const candidates = extractAnonKeyCandidates(text);
      expect(candidates).toEqual([]);
    });

    it('rejects text with context signal but invalid/corrupted JWT structure', () => {
      const text = `
        createClient("https://xyz.supabase.co", "not-a-valid-jwt-string");
      `;
      const candidates = extractAnonKeyCandidates(text);
      expect(candidates).toEqual([]);
    });

    it('deduplicates multiple occurrences of the same key', () => {
      const text = `
        const supabase1 = createClient("url", "${VALID_JWT}");
        const supabase2 = createClient("url", "${VALID_JWT}");
      `;
      const candidates = extractAnonKeyCandidates(text);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toBe(VALID_JWT);
    });
  });

  describe('script origin checks & URL extraction', () => {
    it('accepts relative paths and same-origin URLs', () => {
      expect(isSameOriginScript('/_next/static/chunks/main.js', 'example.com')).toBe(true);
      expect(isSameOriginScript('./bundle.js', 'example.com')).toBe(true);
      expect(isSameOriginScript('https://example.com/assets/app.js', 'example.com')).toBe(true);
      expect(isSameOriginScript('//example.com/assets/app.js', 'example.com')).toBe(true);
    });

    it('rejects third-party CDN scripts to avoid SSRF / supply-chain bloat', () => {
      expect(isSameOriginScript('https://cdn.jsdelivr.net/npm/supabase/dist/index.js', 'example.com')).toBe(false);
      expect(isSameOriginScript('https://unpkg.com/@supabase/supabase-js', 'example.com')).toBe(false);
      expect(isSameOriginScript('https://cdnjs.cloudflare.com/ajax/libs/supabase.js', 'example.com')).toBe(false);
      expect(isSameOriginScript('https://www.google-analytics.com/analytics.js', 'example.com')).toBe(false);
    });

    it('extracts up to MAX_SAME_ORIGIN_SCRIPTS (5) first-party scripts', () => {
      const html = `
        <script src="/_next/static/chunks/1.js"></script>
        <script src="/_next/static/chunks/2.js"></script>
        <script src="https://cdn.jsdelivr.net/third-party.js"></script>
        <script src="/_next/static/chunks/3.js"></script>
        <script src="/_next/static/chunks/4.js"></script>
        <script src="/_next/static/chunks/5.js"></script>
        <script src="/_next/static/chunks/6.js"></script>
      `;
      const urls = extractFirstPartyScriptUrls(html, 'example.com');
      expect(urls).toHaveLength(MAX_SAME_ORIGIN_SCRIPTS);
      expect(urls).toEqual([
        '/_next/static/chunks/1.js',
        '/_next/static/chunks/2.js',
        '/_next/static/chunks/3.js',
        '/_next/static/chunks/4.js',
        '/_next/static/chunks/5.js',
      ]);
    });

    it('extracts inline script contents ignoring script tags with src', () => {
      const html = `
        <script src="/external.js"></script>
        <script>const a = "inline1";</script>
        <div>hello</div>
        <script type="module">const b = "inline2";</script>
      `;
      const contents = extractInlineScriptContents(html);
      expect(contents).toEqual(['const a = "inline1";', 'const b = "inline2";']);
    });
  });

  describe('computeAnonKeyFingerprint', () => {
    it('returns the first 16 hex characters of SHA-256', () => {
      const fp = computeAnonKeyFingerprint(VALID_JWT);
      expect(fp).toHaveLength(16);
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('getOrRefreshProjectAnonKey weekly caching & encryption', () => {
    it('returns cached key when refreshed within last 7 days without hitting network', async () => {
      const now = new Date('2026-09-13T12:00:00Z');
      const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
      const encrypted = encryptValue(VALID_JWT);
      const fingerprint = computeAnonKeyFingerprint(VALID_JWT);

      getProjectAnonKeyMock.mockResolvedValueOnce({
        anonKeyEncrypted: encrypted,
        anonKeyFingerprint: fingerprint,
        anonKeyCheckedAt: fourDaysAgo,
      });

      const result = await getOrRefreshProjectAnonKey('proj_1', 'example.com', { now });

      expect(result).toEqual({ key: VALID_JWT, fingerprint });
      expect(updateProjectAnonKeyMock).not.toHaveBeenCalled();
    });

    it('returns null if checked within 7 days and no anon key was detected', async () => {
      const now = new Date('2026-09-13T12:00:00Z');
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      getProjectAnonKeyMock.mockResolvedValueOnce({
        anonKeyEncrypted: null,
        anonKeyFingerprint: null,
        anonKeyCheckedAt: twoDaysAgo,
      });

      const result = await getOrRefreshProjectAnonKey('proj_1', 'example.com', { now });

      expect(result).toBeNull();
      expect(updateProjectAnonKeyMock).not.toHaveBeenCalled();
    });

    it('refreshes key when check is older than 7 days', async () => {
      const now = new Date('2026-09-13T12:00:00Z');
      const eightDaysAgo = new Date(now.getTime() - (WEEK_IN_MS + 1000));

      getProjectAnonKeyMock.mockResolvedValueOnce({
        anonKeyEncrypted: 'old-encrypted-key',
        anonKeyFingerprint: 'oldfp12345678901',
        anonKeyCheckedAt: eightDaysAgo,
      });

      const homepageHtml = `
        <html><body>
          <script>
            createClient("https://demo.supabase.co", "${VALID_JWT}");
          </script>
        </body></html>
      `;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(homepageHtml),
        }),
      );

      const result = await getOrRefreshProjectAnonKey('proj_1', 'example.com', { now });

      expect(result).not.toBeNull();
      expect(result?.key).toBe(VALID_JWT);
      expect(result?.fingerprint).toBe(computeAnonKeyFingerprint(VALID_JWT));

      expect(updateProjectAnonKeyMock).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          anonKeyEncrypted: expect.any(String),
          anonKeyFingerprint: computeAnonKeyFingerprint(VALID_JWT),
          anonKeyCheckedAt: now,
        }),
      );
    });
  });
});
