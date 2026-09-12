import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProbeUrl,
  isValidProbePath,
  probeTarget,
  probeTargetWithAnonKey,
  SAFE_VALUES,
  sanitizeProbePath,
} from '../lib/runtime/auth-prober/probe.ts';
import { PROBE_USER_AGENT } from '../lib/runtime/auth-prober/types.ts';

describe('runtime auth prober — probeTarget & SSRF guard', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  describe('sanitizeProbePath hardening', () => {
    it('SAFE_VALUES map contains required keys and encoded email', () => {
      expect(SAFE_VALUES).toEqual({
        id: '1',
        postId: '1',
        email: 'test%40example.com',
        token: 'test',
        slug: 'test',
      });
    });

    it('substitutes multi-param patterns correctly', () => {
      expect(sanitizeProbePath('/api/users/[id]/posts/[postId]')).toBe('/api/users/1/posts/1');
      expect(sanitizeProbePath('/orgs/[slug]/members/[id]/verify/[token]')).toBe(
        '/orgs/test/members/1/verify/test',
      );
    });

    it('substitutes encoded email value', () => {
      expect(sanitizeProbePath('/api/users/[email]')).toBe('/api/users/test%40example.com');
    });

    it('falls back to test for unknown bracket placeholder names', () => {
      expect(sanitizeProbePath('/api/orders/[orderNumber]')).toBe('/api/orders/test');
      expect(sanitizeProbePath('/api/[customField]')).toBe('/api/test');
    });

    it('returns patterns with no placeholders unchanged', () => {
      expect(sanitizeProbePath('/api/health/check')).toBe('/api/health/check');
      expect(sanitizeProbePath('/dashboard/settings')).toBe('/dashboard/settings');
      expect(sanitizeProbePath('')).toBe('');
    });

    it('replaces all occurrences of repeated placeholders globally', () => {
      expect(sanitizeProbePath('/users/[id]/drafts/[id]')).toBe('/users/1/drafts/1');
    });
  });

  describe('buildProbeUrl & SSRF defenses', () => {
    it('constructs valid https URL for standard hostnames', () => {
      expect(buildProbeUrl('example.com', '/admin')).toBe('https://example.com/admin');
      expect(buildProbeUrl('sub.domain.org', '/api/users')).toBe('https://sub.domain.org/api/users');
    });

    it('rejects invalid paths (no leading slash, traversal, too long)', () => {
      expect(buildProbeUrl('example.com', 'admin')).toBeNull();
      expect(buildProbeUrl('example.com', '/admin/../etc/passwd')).toBeNull();
      expect(buildProbeUrl('example.com', '/' + 'a'.repeat(201))).toBeNull();
    });

    it('enforces length cap on sanitized concrete path', () => {
      // Path whose concrete substituted version exceeds 200 chars
      const longBase = '/' + 'a'.repeat(195);
      expect(buildProbeUrl('example.com', `${longBase}/[email]`)).toBeNull();
    });

    it('rejects localhost, private IPs, and internal TLDs in production', () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      expect(buildProbeUrl('localhost', '/admin')).toBeNull();
      expect(buildProbeUrl('127.0.0.1', '/admin')).toBeNull();
      expect(buildProbeUrl('192.168.1.1', '/admin')).toBeNull();
      expect(buildProbeUrl('169.254.169.254', '/admin')).toBeNull();
      expect(buildProbeUrl('service.local', '/admin')).toBeNull();
      expect(buildProbeUrl('cluster.internal', '/admin')).toBeNull();
      expect(buildProbeUrl('invalid_host', '/admin')).toBeNull();
    });

    it('permits localhost in dev/test environment for local simulation', () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
      expect(buildProbeUrl('localhost', '/dashboard')).toBe('http://localhost/dashboard');
      expect(buildProbeUrl('127.0.0.1', '/dashboard')).toBe('http://127.0.0.1/dashboard');
      expect(buildProbeUrl('localhost:3000', '/dashboard')).toBe('http://localhost:3000/dashboard');
    });

    it('sanitizes parameterized route patterns like [id] into concrete test paths', () => {
      expect(buildProbeUrl('example.com', '/api/users/[id]')).toBe('https://example.com/api/users/1');
      expect(buildProbeUrl('example.com', '/api/verify/[token]')).toBe('https://example.com/api/verify/test');
    });
  });

  describe('isValidProbePath validation rules', () => {
    it('accepts safe absolute paths and dynamic route patterns', () => {
      expect(isValidProbePath('/admin')).toBe(true);
      expect(isValidProbePath('/api/v1/users')).toBe(true);
      expect(isValidProbePath('/api/users/[id]')).toBe(true);
      expect(isValidProbePath('/orgs/[slug]/members/[id]')).toBe(true);
    });

    it('rejects path without leading slash', () => {
      expect(isValidProbePath('admin')).toBe(false);
      expect(isValidProbePath('api/users')).toBe(false);
    });

    it('rejects directory traversal patterns (..)', () => {
      expect(isValidProbePath('/api/../admin')).toBe(false);
      expect(isValidProbePath('/admin/..')).toBe(false);
    });

    it('rejects paths containing whitespace', () => {
      expect(isValidProbePath('/api/user data')).toBe(false);
      expect(isValidProbePath('/admin ')).toBe(false);
      expect(isValidProbePath('/api/test\n')).toBe(false);
    });

    it('rejects raw paths exceeding 200 characters', () => {
      expect(isValidProbePath('/' + 'a'.repeat(201))).toBe(false);
    });

    it('rejects paths whose concrete substituted version exceeds 200 characters', () => {
      const longBase = '/' + 'a'.repeat(195);
      expect(isValidProbePath(`${longBase}/[email]`)).toBe(false);
    });
  });

  describe('probeTarget HTTP execution', () => {
    it('sends GET with manual redirect and user-agent', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 401,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      });
      vi.stubGlobal('fetch', fetchMock);

      const outcome = await probeTarget('example.com', '/admin');
      expect(outcome).toEqual({ ok: true, status: 401 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(calledUrl).toBe('https://example.com/admin');
      expect(calledOptions.method).toBe('GET');
      expect(calledOptions.redirect).toBe('manual');
      expect(calledOptions.headers['user-agent']).toBe(PROBE_USER_AGENT);
    });

    it('preserves 307 redirect status rather than following to destination', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 307,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      });
      vi.stubGlobal('fetch', fetchMock);

      const outcome = await probeTarget('example.com', '/dashboard');
      expect(outcome).toEqual({ ok: true, status: 307 });
    });

    it('returns error object when network or DNS drops', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com')));

      const outcome = await probeTarget('example.com', '/admin');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain('ENOTFOUND');
      }
    });

    it('returns invalid_target when hostname fails validation', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      const outcome = await probeTarget('192.168.1.5', '/admin');
      expect(outcome).toEqual({ ok: false, error: 'invalid_target' });
    });

    it('probeTargetWithAnonKey sends apikey and authorization Bearer headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      });
      vi.stubGlobal('fetch', fetchMock);

      const testAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig';
      const outcome = await probeTargetWithAnonKey('example.com', '/api/data', testAnonKey);
      expect(outcome).toEqual({ ok: true, status: 200 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(calledUrl).toBe('https://example.com/api/data');
      expect(calledOptions.method).toBe('GET');
      expect(calledOptions.redirect).toBe('manual');
      expect(calledOptions.headers['user-agent']).toBe(PROBE_USER_AGENT);
      expect(calledOptions.headers['apikey']).toBe(testAnonKey);
      expect(calledOptions.headers['authorization']).toBe(`Bearer ${testAnonKey}`);
    });
  });
});
