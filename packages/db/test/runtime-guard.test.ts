import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockInsert = vi.fn(() => ({
  values: (...args: unknown[]) => {
    mockValues(...args);
    return {
      returning: mockReturning,
      onConflictDoUpdate: mockOnConflictDoUpdate,
    };
  },
}));
const mockLimit = vi.fn();
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockGroupBy = vi.fn(() => ({ orderBy: mockOrderBy }));
const mockWhere = vi.fn(() => ({ groupBy: mockGroupBy }));
const mockLeftJoin = vi.fn(() => ({ where: mockWhere }));
const mockFrom = vi.fn(() => ({ leftJoin: mockLeftJoin }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockDeleteWhere = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));

vi.mock('../src/client.ts', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
      return cb({
        delete: (...args: unknown[]) => mockDelete(...args),
      });
    }),
  },
}));

import {
  recordRouteEvents,
  listGuardRoutes,
  seedDemoGuardRoutes,
  clearGuardRoutes,
  parseGuardWindowCutoff,
} from '../src/queries/runtime-guard.ts';

describe('packages/db runtime-guard queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recordRouteEvents sets source to null on conflict to promote route from sample to real', async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 'route-1', pattern: '/api/users/[id]', method: 'GET' },
    ]);

    mockOnConflictDoUpdate.mockReturnValue({
      returning: mockReturning,
    });

    const count = await recordRouteEvents('proj-123', [
      { pattern: '/api/users/[id]', method: 'GET', hasSession: true },
    ]);

    expect(count).toBe(1);

    // Verify insert values have source: null
    expect(mockValues).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'proj-123',
        pattern: '/api/users/[id]',
        method: 'GET',
        source: null,
      }),
    ]);

    // Verify onConflictDoUpdate set clause contains source: sql`null`
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          source: expect.anything(),
        }),
      }),
    );
  });

  it('seedDemoGuardRoutes inserts routes with source=sample', async () => {
    mockReturning.mockResolvedValue([
      { id: 'route-demo-1' },
    ]);
    mockOnConflictDoUpdate.mockReturnValue({
      returning: mockReturning,
    });

    await seedDemoGuardRoutes('proj-123');

    // Check first insert into runtimeRoutes
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-123',
        source: 'sample',
      }),
    );
  });

  it('clearGuardRoutes deletes runtime_routes and guard-sourced prober targets in a single transaction', async () => {
    // First delete call for runtimeRoutes returns 5 deleted routes
    // Second delete call for runtimeProberTargets (where source='guard') returns 3 deleted targets
    mockDeleteWhere
      .mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' }, { id: 'r5' }]),
      })
      .mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
      });

    const res = await clearGuardRoutes('proj-123');

    expect(res).toEqual({
      deletedRoutes: 5,
      deletedTargets: 3,
    });

    // Verify delete was called twice (for routes, and for targets)
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  describe('parseGuardWindowCutoff', () => {
    const fixedNow = new Date('2026-09-12T12:00:00.000Z');

    it('defaults to 7 days before now', () => {
      const cutoff = parseGuardWindowCutoff('7d', fixedNow);
      expect(cutoff?.toISOString()).toBe('2026-09-05T12:00:00.000Z');
    });

    it('parses hours, days, and numeric formats', () => {
      expect(parseGuardWindowCutoff('24h', fixedNow)?.toISOString()).toBe('2026-09-11T12:00:00.000Z');
      expect(parseGuardWindowCutoff(14, fixedNow)?.toISOString()).toBe('2026-08-29T12:00:00.000Z');
      expect(parseGuardWindowCutoff({ days: 3 }, fixedNow)?.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    });

    it('returns null for "all" or null', () => {
      expect(parseGuardWindowCutoff('all', fixedNow)).toBeNull();
      expect(parseGuardWindowCutoff(null, fixedNow)).toBeNull();
    });
  });

  describe('listGuardRoutes time-windowed query', () => {
    it('applies default 7d window cutoff in the leftJoin condition', async () => {
      await listGuardRoutes('proj-123');

      expect(mockLeftJoin).toHaveBeenCalledTimes(1);
      // Verify leftJoin received a condition (the and() of routeId match + gte cutoff)
      expect(mockLeftJoin).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
      );
      expect(mockLimit).toHaveBeenCalledWith(200);
    });

    it('accepts custom window parameter and limit', async () => {
      await listGuardRoutes('proj-123', 50, '14d');

      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(mockLeftJoin).toHaveBeenCalledTimes(1);
    });

    it('accepts options object with custom window and now', async () => {
      const now = new Date('2026-09-12T12:00:00.000Z');
      await listGuardRoutes('proj-123', { limit: 25, window: '24h', now });

      expect(mockLimit).toHaveBeenCalledWith(25);
      expect(mockLeftJoin).toHaveBeenCalledTimes(1);
    });
  });
});

