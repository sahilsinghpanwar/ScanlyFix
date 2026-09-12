import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProbeUrl, probeTarget } from '../lib/runtime/auth-prober/probe.ts';
import { PROBE_USER_AGENT } from '../lib/runtime/auth-prober/types.ts';

describe('runtime auth prober — probeTarget & SSRF guard', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    vi.restoreAllMocks();
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
  });
});
