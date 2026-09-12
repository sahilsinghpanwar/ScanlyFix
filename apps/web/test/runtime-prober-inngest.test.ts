import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const listProberEligibleProjectIdsMock = vi.fn();
const getProjectOwnerEmailMock = vi.fn();
const getRuntimeProjectContextMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  listProberEligibleProjectIds: (...args: unknown[]) => listProberEligibleProjectIdsMock(...args),
  getProjectOwnerEmail: (...args: unknown[]) => getProjectOwnerEmailMock(...args),
  getRuntimeProjectContext: (...args: unknown[]) => getRuntimeProjectContextMock(...args),
}));

const runAuthProberMock = vi.fn();
vi.mock('../lib/runtime/auth-prober/index.ts', () => ({
  runAuthProber: (...args: unknown[]) => runAuthProberMock(...args),
}));

const sendEmailMock = vi.fn();
vi.mock('../lib/email.ts', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

const syncGuardRoutesToProberMock = vi.fn().mockResolvedValue({ synced: 2, candidates: 5 });
vi.mock('../lib/runtime/guard/sync.ts', () => ({
  syncGuardRoutesToProber: (...args: unknown[]) => syncGuardRoutesToProberMock(...args),
}));

type InngestHandler = (ctx: {
  event?: { data: Record<string, unknown> };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
    sendEvent: (name: string, events: unknown[]) => Promise<unknown>;
    sleepUntil: (name: string, date: Date | string) => Promise<unknown>;
  };
  logger: { info: Mock; warn: Mock; error: Mock };
}) => Promise<unknown>;

const registeredFunctions = new Map<string, InngestHandler>();

vi.mock('../lib/inngest.ts', () => ({
  EVENTS: {
    authProberRunProject: 'runtime/auth-prober.run-project',
  },
  inngest: {
    createFunction: (config: { id: string }, handler: InngestHandler) => {
      registeredFunctions.set(config.id, handler);
      return { config, __handler: handler };
    },
  },
}));

const {
  calculateProberJitterMinutes,
  calculateProberSleepUntil,
} = await import('../inngest/functions/runtime-auth-prober.ts');

function makeContext(eventData: Record<string, unknown> = {}) {
  return {
    event: { data: eventData },
    step: {
      run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
      sendEvent: vi.fn(async () => ({ ids: ['evt_1'] })),
      sleepUntil: vi.fn(async () => undefined),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('runtime auth prober Inngest fan-out & jitter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('deterministic jitter function', () => {
    it('is strictly deterministic: returns identical slot for same projectId', () => {
      const pid = '00000000-0000-0000-0000-000000000001';
      const slot1 = calculateProberJitterMinutes(pid);
      const slot2 = calculateProberJitterMinutes(pid);
      const slot3 = calculateProberJitterMinutes(pid);

      expect(slot1).toBe(slot2);
      expect(slot2).toBe(slot3);
    });

    it('returns integers strictly within [0, 60) for arbitrary project IDs', () => {
      const testIds = [
        'proj_alpha',
        'proj_beta',
        '7da18d35-9904-4905-82ea-65da4e719814',
        'c0a80101-0000-0000-0000-000000000000',
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        'short-id',
        '',
      ];

      for (const id of testIds) {
        const slot = calculateProberJitterMinutes(id);
        expect(Number.isInteger(slot)).toBe(true);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(60);
      }
    });

    it('distributes slots across different project IDs', () => {
      const slots = new Set<number>();
      for (let i = 0; i < 50; i++) {
        slots.add(calculateProberJitterMinutes(`project-uuid-${i}`));
      }
      // Across 50 projects, there should be substantial variation (more than 15 distinct slots)
      expect(slots.size).toBeGreaterThan(15);
    });

    it('calculateProberSleepUntil returns a Date offset by the jitter minutes', () => {
      const base = new Date('2026-09-13T02:00:00.000Z');
      const pid = 'proj_test_jitter';
      const expectedMinutes = calculateProberJitterMinutes(pid);

      const targetDate = calculateProberSleepUntil(pid, base);
      const diffMs = targetDate.getTime() - base.getTime();
      expect(diffMs).toBe(expectedMinutes * 60 * 1000);
    });
  });

  describe('parent cron function: runtime/auth-prober-nightly', () => {
    it('runs cleanly and dispatches 0 events when no projects are eligible', async () => {
      listProberEligibleProjectIdsMock.mockResolvedValueOnce([]);

      const handler = registeredFunctions.get('runtime/auth-prober-nightly');
      expect(handler).toBeDefined();

      const ctx = makeContext();
      const result = await handler!(ctx as never);

      expect(result).toEqual({ eligibleCount: 0, dispatched: 0 });
      expect(ctx.step.sendEvent).not.toHaveBeenCalled();
      expect(ctx.logger.info).toHaveBeenCalledWith('auth-prober: eligible projects', { count: 0 });
    });

    it('fans out per-project events via step.sendEvent for all eligible projects', async () => {
      listProberEligibleProjectIdsMock.mockResolvedValueOnce(['proj_1', 'proj_2', 'proj_3']);

      const handler = registeredFunctions.get('runtime/auth-prober-nightly');
      expect(handler).toBeDefined();

      const ctx = makeContext();
      const result = await handler!(ctx as never);

      expect(result).toEqual({ eligibleCount: 3, dispatched: 3 });
      expect(ctx.step.sendEvent).toHaveBeenCalledWith('fan-out-prober-runs', [
        { name: 'runtime/auth-prober.run-project', data: { projectId: 'proj_1' } },
        { name: 'runtime/auth-prober.run-project', data: { projectId: 'proj_2' } },
        { name: 'runtime/auth-prober.run-project', data: { projectId: 'proj_3' } },
      ]);
    });
  });

  describe('child worker function: runtime/auth-prober-project', () => {
    it('executes jitter sleep, syncs guard routes, runs prober, and alerts on findings', async () => {
      const handler = registeredFunctions.get('runtime/auth-prober-project');
      expect(handler).toBeDefined();

      getProjectOwnerEmailMock.mockResolvedValueOnce('owner@example.com');
      getRuntimeProjectContextMock.mockResolvedValueOnce({
        id: 'proj_1',
        hostname: 'saas.example.com',
        isVerified: true,
      });

      runAuthProberMock.mockImplementationOnce(async (projectId, hooks) => {
        await hooks.onNewFindings?.([
          {
            path: '/admin',
            severity: 'critical',
            baselineStatus: 403,
            actualStatus: 200,
          },
        ]);
        return {
          projectId,
          ranAt: new Date().toISOString(),
          baselinesRecorded: 0,
          checked: 5,
          newFindings: 1,
          autoResolved: 0,
          stillOpen: 0,
          errors: 0,
        };
      });

      const ctx = makeContext({ projectId: 'proj_1' });
      const result = await handler!(ctx as never);

      // 1. Jitter sleep called
      expect(ctx.step.sleepUntil).toHaveBeenCalledWith(
        'jitter-sleep',
        expect.any(Date),
      );

      // 2. Guard sync called
      expect(syncGuardRoutesToProberMock).toHaveBeenCalledWith('proj_1');

      // 3. Prober run called
      expect(runAuthProberMock).toHaveBeenCalledWith('proj_1', expect.any(Object));

      // 4. Alert email sent
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@example.com',
          subject: expect.stringContaining('saas.example.com'),
        }),
      );

      expect(result).toMatchObject({
        projectId: 'proj_1',
        summary: expect.objectContaining({ checked: 5, newFindings: 1 }),
      });
    });
  });
});
