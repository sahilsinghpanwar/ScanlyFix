import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const ALPHA_SECRET = 'alpha-secret-32-chars-long-test';
const BETA_SECRET = 'beta-secret-32-chars-long-test!';

const mockProjects: Record<string, { id: string; secret: string | null; host: string; ceilingMicroUsd: number | null }> = {
  'proj-alpha': {
    id: 'proj-alpha',
    secret: ALPHA_SECRET,
    host: 'alpha.example.com',
    ceilingMicroUsd: 5_000_000, // $5.00/hour
  },
  'proj-beta': {
    id: 'proj-beta',
    secret: BETA_SECRET,
    host: 'beta.example.com',
    ceilingMicroUsd: null, // No ceiling set
  },
  'proj-no-secret': {
    id: 'proj-no-secret',
    secret: null,
    host: 'no-secret.example.com',
    ceilingMicroUsd: 10_000_000,
  },
};

vi.mock('@scanlyfix/db', () => ({
  getProjectRuntimeSecret: vi.fn().mockImplementation(async (projectId: string) => {
    return mockProjects[projectId]?.secret ?? null;
  }),
  getProjectRuntimeAuthSecrets: vi.fn().mockImplementation(async (projectId: string) => {
    const sec = mockProjects[projectId]?.secret ?? null;
    return {
      current: sec,
      prev: null,
      rotatedAt: null,
      validSecrets: sec ? [sec] : [],
    };
  }),
  findProjectIdByHost: vi.fn().mockImplementation(async (host: string) => {
    const cleanHost = host.trim().toLowerCase().replace(/^https?:\/\//, '').split(':')[0];
    for (const p of Object.values(mockProjects)) {
      if (p.host === cleanHost) return p.id;
    }
    return null;
  }),
  getSpendCeilingMicroUsd: vi.fn().mockImplementation(async (projectId: string) => {
    return mockProjects[projectId]?.ceilingMicroUsd ?? null;
  }),
}));

describe('GET /api/runtime/config endpoint', () => {
  let GET: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const route = await import('../app/api/runtime/config/route.ts');
    GET = route.GET as unknown as (req: Request) => Promise<Response>;
  });

  it('returns ceilingUsdPerHour when valid signature is provided', async () => {
    const req = new Request('http://localhost:3000/api/runtime/config?projectId=proj-alpha', {
      method: 'GET',
      headers: {
        'x-runtime-signature': ALPHA_SECRET,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      ok: true,
      ceilingUsdPerHour: 5,
    });
  });

  it('returns null ceilingUsdPerHour when project has no ceiling set', async () => {
    const req = new Request('http://localhost:3000/api/runtime/config?projectId=proj-beta', {
      method: 'GET',
      headers: {
        'x-runtime-signature': BETA_SECRET,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      ok: true,
      ceilingUsdPerHour: null,
    });
  });

  it('accepts valid HMAC-SHA256 signature', async () => {
    const hmacSig = createHmac('sha256', ALPHA_SECRET).update('').digest('hex');
    const req = new Request('http://localhost:3000/api/runtime/config?projectId=proj-alpha', {
      method: 'GET',
      headers: {
        'x-runtime-signature': hmacSig,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ceilingUsdPerHour).toBe(5);
  });

  it('rejects missing x-runtime-signature header with 401', async () => {
    const req = new Request('http://localhost:3000/api/runtime/config?projectId=proj-alpha', {
      method: 'GET',
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('unauthorized');
  });

  it('rejects invalid signature with 401', async () => {
    const req = new Request('http://localhost:3000/api/runtime/config?projectId=proj-alpha', {
      method: 'GET',
      headers: {
        'x-runtime-signature': 'wrong-signature-value',
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('unauthorized');
  });

  it('rejects timestamps older than 5 minutes (replay attack)', async () => {
    const staleTimestamp = Date.now() - 6 * 60 * 1000;
    const req = new Request('http://localhost:3000/api/runtime/config?projectId=proj-alpha', {
      method: 'GET',
      headers: {
        'x-runtime-signature': ALPHA_SECRET,
        'x-runtime-timestamp': String(staleTimestamp),
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('unauthorized');
  });

  it('auto-detects project via host header lookup hint with valid signature', async () => {
    const req = new Request('http://localhost:3000/api/runtime/config', {
      method: 'GET',
      headers: {
        'x-runtime-host': 'alpha.example.com',
        'x-runtime-signature': ALPHA_SECRET,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ceilingUsdPerHour).toBe(5);
  });

  it('rejects missing projectId and host with 400', async () => {
    const req = new Request('http://localhost:3000/api/runtime/config', {
      method: 'GET',
    });

    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('missing_project_id');
  });
});
