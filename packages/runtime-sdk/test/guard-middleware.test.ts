import { describe, expect, it, vi } from 'vitest';
import { withGuard, type NextRequestLike, type NextFetchEventLike } from '../src/guard/middleware.ts';
import { createRuntime } from '../src/runtime.ts';

function createMockRequest(pathname: string, options: { method?: string; cookies?: string; isServerAction?: boolean } = {}): NextRequestLike {
  const headers = new Map<string, string>();
  if (options.cookies) headers.set('cookie', options.cookies);
  if (options.isServerAction) headers.set('next-action', '1');

  return {
    nextUrl: { pathname },
    method: options.method ?? 'GET',
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => headers.has(name.toLowerCase()),
    },
  };
}

describe('withGuard middleware', () => {
  it('returns NextResponse.next() when no user middleware is provided (prevents blank screen)', async () => {
    const reportedEvents: any[] = [];
    const mockRuntime = createRuntime({
      projectId: 'test-proj',
      ingestUrl: 'http://localhost/api/runtime/ingest',
    });
    vi.spyOn(mockRuntime, 'report').mockImplementation((e) => reportedEvents.push(e));
    vi.spyOn(mockRuntime, 'flush').mockResolvedValue();

    const middleware = withGuard(undefined, { runtime: mockRuntime });
    const req = createMockRequest('/dashboard');

    const res = await middleware(req);

    // Next.js NextResponse.next() sets the x-middleware-next header
    expect(res).toBeDefined();
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(reportedEvents).toHaveLength(1);
    expect(reportedEvents[0].pattern).toBe('/dashboard');
  });

  it('delegates to userMiddleware when supplied and preserves return value', async () => {
    const mockRuntime = createRuntime({
      projectId: 'test-proj',
      ingestUrl: 'http://localhost/api/runtime/ingest',
    });
    vi.spyOn(mockRuntime, 'report').mockImplementation(() => {});
    vi.spyOn(mockRuntime, 'flush').mockResolvedValue();

    const customResponse = new Response('custom auth redirect', { status: 302 });
    const userMiddleware = vi.fn().mockResolvedValue(customResponse);

    const middleware = withGuard(userMiddleware, { runtime: mockRuntime });
    const req = createMockRequest('/api/protected');

    const res = await middleware(req);

    expect(userMiddleware).toHaveBeenCalledWith(req, undefined);
    expect(res).toBe(customResponse);
    expect(res.status).toBe(302);
  });

  it('passes flush promise to event.waitUntil on Edge/Serverless environments', async () => {
    const mockRuntime = createRuntime({
      projectId: 'test-proj',
      ingestUrl: 'http://localhost/api/runtime/ingest',
    });
    const flushPromise = Promise.resolve();
    vi.spyOn(mockRuntime, 'report').mockImplementation(() => {});
    vi.spyOn(mockRuntime, 'flush').mockReturnValue(flushPromise);

    const waitUntilMock = vi.fn();
    const mockEvent: NextFetchEventLike = { waitUntil: waitUntilMock };

    const middleware = withGuard(undefined, { runtime: mockRuntime });
    const req = createMockRequest('/api/checkout');

    await middleware(req, mockEvent);

    expect(waitUntilMock).toHaveBeenCalledWith(flushPromise);
  });

  it('skips excluded routes like static assets and root /', async () => {
    const reportedEvents: any[] = [];
    const mockRuntime = createRuntime({
      projectId: 'test-proj',
      ingestUrl: 'http://localhost/api/runtime/ingest',
    });
    vi.spyOn(mockRuntime, 'report').mockImplementation((e) => reportedEvents.push(e));

    const middleware = withGuard(undefined, { runtime: mockRuntime });

    // Root path /
    await middleware(createMockRequest('/'));
    // Static asset
    await middleware(createMockRequest('/_next/static/chunk.js'));
    await middleware(createMockRequest('/favicon.ico'));
    await middleware(createMockRequest('/logo.png'));

    expect(reportedEvents).toHaveLength(0);
  });

  it('never throws even if runtime reporting or flushing fails', async () => {
    const mockRuntime = createRuntime({
      projectId: 'test-proj',
      ingestUrl: 'http://localhost/api/runtime/ingest',
    });
    vi.spyOn(mockRuntime, 'report').mockImplementation(() => {
      throw new Error('Telemetry network crashed');
    });

    const middleware = withGuard(undefined, { runtime: mockRuntime });
    const req = createMockRequest('/safe-route');

    // Must not throw, must return valid NextResponse
    const res = await middleware(req);
    expect(res).toBeDefined();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('auto-detects host domain and passes it to runtime.flush for zero-config domain detection', async () => {
    const mockRuntime = createRuntime({
      ingestUrl: 'http://localhost/api/runtime/ingest',
    });
    const flushSpy = vi.spyOn(mockRuntime, 'flush').mockResolvedValue();

    const middleware = withGuard(undefined, { runtime: mockRuntime });
    const req = createMockRequest('/api/profile');

    await middleware(req);

    // Should pass the hostname from req.nextUrl.hostname
    expect(flushSpy).toHaveBeenCalledWith(undefined); // createMockRequest has no hostname by default

    // Now test with explicit host header
    const reqWithHost: NextRequestLike = {
      nextUrl: { pathname: '/api/orders' },
      method: 'GET',
      headers: {
        get: (name) => (name.toLowerCase() === 'host' ? 'live-shop-mu.vercel.app' : null),
        has: (name) => name.toLowerCase() === 'host',
      },
    };

    await middleware(reqWithHost);
    expect(flushSpy).toHaveBeenCalledWith('live-shop-mu.vercel.app');
  });

  // ── TASK 1: waitUntil Portability Tests ────────────────────────────────────
  describe('waitUntil Portability & Fallback', () => {
    it('accepts an explicit waitUntil executor in GuardOptions (e.g. Cloudflare ctx.waitUntil)', async () => {
      const mockRuntime = createRuntime({
        projectId: 'test-proj',
        ingestUrl: 'http://localhost/api/runtime/ingest',
      });
      const flushPromise = Promise.resolve();
      vi.spyOn(mockRuntime, 'report').mockImplementation(() => {});
      vi.spyOn(mockRuntime, 'flush').mockReturnValue(flushPromise);

      const customWaitUntil = vi.fn();
      const middleware = withGuard(undefined, {
        runtime: mockRuntime,
        waitUntil: customWaitUntil,
      });

      const req = createMockRequest('/api/cloudflare-route');
      await middleware(req);

      expect(customWaitUntil).toHaveBeenCalledWith(flushPromise);
    });

    it('self-hosted Node fallback: when no waitUntil executor is available, cleanly falls back to void runtime.flush()', async () => {
      const mockRuntime = createRuntime({
        projectId: 'test-proj',
        ingestUrl: 'http://localhost/api/runtime/ingest',
      });
      const flushSpy = vi.spyOn(mockRuntime, 'flush').mockResolvedValue();
      vi.spyOn(mockRuntime, 'report').mockImplementation(() => {});

      // Running on self-hosted Node: no options.waitUntil, event has no waitUntil, @vercel/functions is absent
      const middleware = withGuard(undefined, { runtime: mockRuntime });
      const req = createMockRequest('/api/self-hosted-route');

      // Second argument (event) is undefined, as typical in self-hosted Node custom servers
      const res = await middleware(req, undefined);

      expect(res).toBeDefined();
      expect(res.headers.get('x-middleware-next')).toBe('1');
      expect(flushSpy).toHaveBeenCalled();
    });

    it('never throws even if the waitUntil executor throws (e.g. called outside request scope)', async () => {
      const mockRuntime = createRuntime({
        projectId: 'test-proj',
        ingestUrl: 'http://localhost/api/runtime/ingest',
      });
      vi.spyOn(mockRuntime, 'flush').mockResolvedValue();
      vi.spyOn(mockRuntime, 'report').mockImplementation(() => {});

      const throwingWaitUntil = vi.fn().mockImplementation(() => {
        throw new Error('waitUntil can only be called while handling a request');
      });

      const middleware = withGuard(undefined, {
        runtime: mockRuntime,
        waitUntil: throwingWaitUntil,
      });

      const req = createMockRequest('/api/edge-error-route');

      // Must not throw, must return valid NextResponse
      const res = await middleware(req);
      expect(res).toBeDefined();
      expect(res.headers.get('x-middleware-next')).toBe('1');
      expect(throwingWaitUntil).toHaveBeenCalled();
    });

    it('prefers options.waitUntil over event.waitUntil if both are supplied', async () => {
      const mockRuntime = createRuntime({
        projectId: 'test-proj',
        ingestUrl: 'http://localhost/api/runtime/ingest',
      });
      const flushPromise = Promise.resolve();
      vi.spyOn(mockRuntime, 'flush').mockReturnValue(flushPromise);
      vi.spyOn(mockRuntime, 'report').mockImplementation(() => {});

      const optionsWaitUntil = vi.fn();
      const eventWaitUntil = vi.fn();

      const middleware = withGuard(undefined, {
        runtime: mockRuntime,
        waitUntil: optionsWaitUntil,
      });

      const req = createMockRequest('/api/precedence-route');
      await middleware(req, { waitUntil: eventWaitUntil });

      expect(optionsWaitUntil).toHaveBeenCalledWith(flushPromise);
      expect(eventWaitUntil).not.toHaveBeenCalled();
    });
  });
});


