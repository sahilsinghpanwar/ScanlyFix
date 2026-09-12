import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const ALPHA_SECRET = 'alpha-secret-32-chars-long-test';
const BETA_SECRET = 'beta-secret-32-chars-long-test!';

const mockProjectsDb: Record<
  string,
  {
    id: string;
    secret: string | null;
    prevSecret?: string | null;
    rotatedAt?: Date | null;
    host: string;
  }
> = {
  'proj-alpha': { id: 'proj-alpha', secret: ALPHA_SECRET, host: 'alpha.example.com' },
  'proj-beta': { id: 'proj-beta', secret: BETA_SECRET, host: 'beta.example.com' },
  'proj-no-secret': { id: 'proj-no-secret', secret: null, host: 'no-secret.example.com' },
};

vi.mock('@scanlyfix/db', () => ({
  recordRouteEvents: vi.fn().mockResolvedValue(1),
  recordAiCallEvents: vi.fn().mockResolvedValue(1),
  getProjectRuntimeSecret: vi.fn().mockImplementation(async (projectId: string) => {
    return mockProjectsDb[projectId]?.secret ?? null;
  }),
  getProjectRuntimeAuthSecrets: vi.fn().mockImplementation(async (projectId: string) => {
    const p = mockProjectsDb[projectId] as any;
    if (!p || !p.secret) return { current: null, prev: null, rotatedAt: null, validSecrets: [] };
    const validSecrets = [p.secret];
    if (p.prevSecret && p.rotatedAt) {
      const elapsed = Date.now() - p.rotatedAt.getTime();
      if (elapsed >= 0 && elapsed <= 24 * 3600_000) {
        validSecrets.push(p.prevSecret);
      }
    }
    return {
      current: p.secret,
      prev: p.prevSecret ?? null,
      rotatedAt: p.rotatedAt ?? null,
      validSecrets,
    };
  }),
  findProjectIdByHost: vi.fn().mockImplementation(async (host: string) => {
    const cleanHost = host.trim().toLowerCase().replace(/^https?:\/\//, '').split(':')[0];
    for (const p of Object.values(mockProjectsDb)) {
      if (p.host === cleanHost) return p.id;
    }
    return null;
  }),
}));

describe('Runtime Ingest Route Security Audit & Hardening', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const route = await import('../app/api/runtime/ingest/route.ts');
    POST = route.POST as unknown as (req: Request) => Promise<Response>;
  });

  const validPayload = JSON.stringify({
    events: [
      {
        type: 'ai_call',
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 150,
        completionTokens: 80,
        latencyMs: 320,
      },
    ],
  });

  // ── TEST (a): valid signature + wrong host → accepted ──────────────────────
  it('(a) valid signature + wrong host is accepted', async () => {
    const secret = ALPHA_SECRET;
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-host': 'completely-wrong-unrelated-domain.evil.com',
        'x-runtime-signature': secret,
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.recordedAi).toBe(1);
  });

  // ── TEST (b): wrong signature + valid host → 401 ────────────────────────────
  it('(b) wrong signature + valid host returns 401 unauthorized', async () => {
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host': 'alpha.example.com', // host matches proj-alpha
        'x-runtime-signature': 'attacker-forged-wrong-secret',
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('unauthorized');
  });

  // ── TEST (c): signature from a DIFFERENT project's secret → 401 ─────────────
  it('(c) signature from a DIFFERENT project\'s secret returns 401 unauthorized', async () => {
    const secretBeta = BETA_SECRET;

    // Request targets proj-alpha, but carries proj-beta's secret
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secretBeta,
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('unauthorized');
  });

  // ── TEST (d): missing signature even with matching host → 401 ───────────────
  it('(d) missing signature with valid host returns 401 unauthorized', async () => {
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host': 'alpha.example.com',
        // No x-runtime-signature header!
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('unauthorized');
  });

  // ── TEST (e): project without configured secret in DB → 401 ─────────────────
  it('(e) project with null secret in DB returns 401 unauthorized', async () => {
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-no-secret',
        'x-runtime-signature': 'any-secret',
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('unauthorized');
  });

  // ── TEST (f): HMAC-SHA256 signature verification ────────────────────────────
  it('accepts valid HMAC-SHA256 signature over raw request body', async () => {
    const secret = ALPHA_SECRET;
    const hmacSig = createHmac('sha256', secret).update(validPayload).digest('hex');

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': `sha256=${hmacSig}`,
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  // ── TEST (g): Replay window enforcement ─────────────────────────────────────
  it('rejects timestamps older than 5 minutes (replay attack)', async () => {
    const secret = ALPHA_SECRET;
    const oldTimestamp = Date.now() - (6 * 60 * 1000); // 6 mins ago (exceeds 5 min window)

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secret,
        'x-runtime-timestamp': String(oldTimestamp),
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('unauthorized');
    expect(data.hint).toContain('replay window');
  });

  it('accepts fresh timestamp within replay window', async () => {
    const secret = ALPHA_SECRET;
    const freshTimestamp = Date.now() - 30_000; // 30s ago

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secret,
        'x-runtime-timestamp': String(freshTimestamp),
      },
      body: validPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  // ── TEST (h): Body size cap enforcement ─────────────────────────────────────
  it('rejects oversized payloads (> 256 KB) with 413 Payload Too Large', async () => {
    const secret = ALPHA_SECRET;
    const bigString = 'x'.repeat(260 * 1024); // 260 KB > 256 KB
    const bigBody = JSON.stringify({ events: [], dummy: bigString });

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(bigBody.length),
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secret,
      },
      body: bigBody,
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error).toBe('payload_too_large');
  });

  // ── TEST (i): Event count cap enforcement ───────────────────────────────────
  it('rejects requests with more than 100 events with 400 Payload Too Large', async () => {
    const secret = ALPHA_SECRET;
    const events = Array.from({ length: 101 }, (_, i) => ({
      pattern: `/api/route-${i}`,
      method: 'GET',
    }));

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secret,
      },
      body: JSON.stringify({ events }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('payload_too_large');
  });

  // ── TEST (j): Route pattern regex validation ────────────────────────────────
  it('filters out invalid route patterns and disallowed HTTP verbs', async () => {
    const { recordRouteEvents } = await import('@scanlyfix/db');
    const secret = ALPHA_SECRET;

    const payload = JSON.stringify({
      events: [
        { pattern: '/valid/route', method: 'POST', hasSession: true },
        { pattern: 'invalid-no-leading-slash', method: 'GET' }, // invalid pattern
        { pattern: '/valid/path', method: 'FAKE_VERB' }, // invalid method
        { pattern: '/script/<svg/onload=alert(1)>', method: 'GET' }, // XSS attempt in pattern
      ],
    });

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secret,
      },
      body: payload,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    // Only the single valid event should have been forwarded to recordRouteEvents
    expect(recordRouteEvents).toHaveBeenCalledWith('proj-alpha', [
      { pattern: '/valid/route', method: 'POST', kind: undefined, hasSession: true },
    ]);
  });

  // ── TEST (k): AI telemetry safe integer bounds ──────────────────────────────
  it('enforces safe integer bounds and clamps extreme values safely', async () => {
    const { recordAiCallEvents } = await import('@scanlyfix/db');
    const secret = ALPHA_SECRET;

    const payload = JSON.stringify({
      events: [
        {
          type: 'ai_call',
          provider: 'openai',
          model: 'gpt-4o',
          promptTokens: -50, // negative
          completionTokens: 999_999_999_999, // exceeds 10M cap
          latencyMs: 99_999_999, // exceeds 1 hour cap
          userHash: 'legit_user_123',
        },
        {
          type: 'ai_call',
          provider: 'evil-script<alert>', // unsafe provider name
          model: 'evil-model<alert>',
          promptTokens: 'one-hundred', // not a number
          completionTokens: 1.5, // float, not safe integer
          latencyMs: NaN,
        },
      ],
    });

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secret,
      },
      body: payload,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(recordAiCallEvents).toHaveBeenCalledWith('proj-alpha', [
      expect.objectContaining({
        promptTokens: 0, // clamped from negative
        completionTokens: 10_000_000, // clamped to MAX_SAFE_TOKENS
        latencyMs: 3_600_000, // clamped to 1 hr MAX_SAFE_LATENCY_MS
        userHash: 'legit_user_123',
      }),
      expect.objectContaining({
        provider: 'unknown', // sanitized from unsafe characters
        model: 'unknown',
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
      }),
    ]);
  });
});

describe('Runtime Ingest Route - Guard Route Events Security Matrix', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const route = await import('../app/api/runtime/ingest/route.ts');
    POST = route.POST as unknown as (req: Request) => Promise<Response>;
  });

  const guardPayload = JSON.stringify({
    events: [
      {
        type: 'route',
        pattern: '/api/users/[id]',
        method: 'GET',
        kind: 'route',
        hasSession: true,
      },
      {
        type: 'route',
        pattern: '/api/projects/[id]/settings',
        method: 'POST',
        kind: 'server_action',
        hasSession: true,
      },
    ],
  });

  it('Guard (a): valid signature + unexpected host → accepted and routes recorded', async () => {
    const { recordRouteEvents } = await import('@scanlyfix/db');
    const secret = ALPHA_SECRET;
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-host': 'unexpected-spoofed-host.evil.com',
        'x-runtime-signature': secret,
      },
      body: guardPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.recordedRoutes).toBe(1);
    expect(recordRouteEvents).toHaveBeenCalledWith('proj-alpha', [
      {
        pattern: '/api/users/[id]',
        method: 'GET',
        kind: 'route',
        hasSession: true,
      },
      {
        pattern: '/api/projects/[id]/settings',
        method: 'POST',
        kind: 'server_action',
        hasSession: true,
      },
    ]);
  });

  it('Guard (b): matching host + bad signature → 401 unauthorized', async () => {
    const { recordRouteEvents } = await import('@scanlyfix/db');
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host': 'alpha.example.com', // host hint resolves to proj-alpha
        'x-runtime-signature': 'invalid-attacker-signature',
      },
      body: guardPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('unauthorized');
    expect(recordRouteEvents).not.toHaveBeenCalled();
  });

  it('Guard (c): signature signed with a DIFFERENT project secret → 401 unauthorized', async () => {
    const { recordRouteEvents } = await import('@scanlyfix/db');
    const secretBeta = BETA_SECRET;

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-project-id': 'proj-alpha',
        'x-runtime-signature': secretBeta, // Signed with proj-beta secret!
      },
      body: guardPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBe('unauthorized');
    expect(recordRouteEvents).not.toHaveBeenCalled();
  });

  it('Guard (d): host is lookup hint only; valid HMAC-SHA256 signature authenticates host-detected project', async () => {
    const { recordRouteEvents } = await import('@scanlyfix/db');
    const hmacSig = createHmac('sha256', ALPHA_SECRET).update(guardPayload).digest('hex');

    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host': 'alpha.example.com', // hint resolves to proj-alpha
        'x-runtime-signature': `sha256=${hmacSig}`,
      },
      body: guardPayload,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.recordedRoutes).toBe(1);
    expect(recordRouteEvents).toHaveBeenCalledWith('proj-alpha', expect.any(Array));
  });

  describe('Task 6: Secret Rotation Grace Window', () => {
    const OLD_SECRET = 'old-secret-prev-version-32-chars';
    const NEW_SECRET = 'new-secret-current-vers-32-chars';

    it('old secret is valid within 24h grace window (both old and new accepted)', async () => {
      // Rotated 2 hours ago
      mockProjectsDb['proj-rotated'] = {
        id: 'proj-rotated',
        secret: NEW_SECRET,
        prevSecret: OLD_SECRET,
        rotatedAt: new Date(Date.now() - 2 * 3600_000), // 2 hours ago
        host: 'rotated.example.com',
      };

      // 1. Request signed with OLD secret within grace -> accepted (200)
      const oldReq = new Request('http://localhost:3000/api/runtime/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runtime-project-id': 'proj-rotated',
          'x-runtime-signature': OLD_SECRET,
        },
        body: guardPayload,
      });

      const oldRes = await POST(oldReq);
      expect(oldRes.status).toBe(200);
      const oldData = await oldRes.json();
      expect(oldData.ok).toBe(true);

      // 2. Request signed with NEW secret within grace -> accepted (200)
      const newReq = new Request('http://localhost:3000/api/runtime/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runtime-project-id': 'proj-rotated',
          'x-runtime-signature': NEW_SECRET,
        },
        body: guardPayload,
      });

      const newRes = await POST(newReq);
      expect(newRes.status).toBe(200);
      const newData = await newRes.json();
      expect(newData.ok).toBe(true);
    });

    it('old secret is rejected after 24h grace window (only new accepted)', async () => {
      // Rotated 25 hours ago (> 24h grace window)
      mockProjectsDb['proj-expired-grace'] = {
        id: 'proj-expired-grace',
        secret: NEW_SECRET,
        prevSecret: OLD_SECRET,
        rotatedAt: new Date(Date.now() - 25 * 3600_000), // 25 hours ago
        host: 'expired.example.com',
      };

      // 1. Request signed with OLD secret after grace -> rejected (401)
      const oldReq = new Request('http://localhost:3000/api/runtime/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runtime-project-id': 'proj-expired-grace',
          'x-runtime-signature': OLD_SECRET,
        },
        body: guardPayload,
      });

      const oldRes = await POST(oldReq);
      expect(oldRes.status).toBe(401);
      const oldData = await oldRes.json();
      expect(oldData.ok).toBe(false);
      expect(oldData.error).toBe('unauthorized');

      // 2. Request signed with NEW secret -> still accepted (200)
      const newReq = new Request('http://localhost:3000/api/runtime/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runtime-project-id': 'proj-expired-grace',
          'x-runtime-signature': NEW_SECRET,
        },
        body: guardPayload,
      });

      const newRes = await POST(newReq);
      expect(newRes.status).toBe(200);
      const newData = await newRes.json();
      expect(newData.ok).toBe(true);
    });
  });
});

