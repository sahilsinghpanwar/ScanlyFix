import { beforeEach, describe, expect, it, vi } from 'vitest';

const listGuardRoutesMock = vi.fn();
const seedProberTargetsMock = vi.fn();
const upgradeProberTargetSourceMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  listGuardRoutes: (...args: unknown[]) => listGuardRoutesMock(...args),
  seedProberTargets: (...args: unknown[]) => seedProberTargetsMock(...args),
  upgradeProberTargetSource: (...args: unknown[]) => upgradeProberTargetSourceMock(...args),
}));

import {
  syncGuardRoutesToProber,
  isRouteFresh,
  MAX_ROUTE_STALENESS_DAYS,
} from '../lib/runtime/guard/sync.ts';

describe('syncGuardRoutesToProber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zero when no routes are observed', async () => {
    listGuardRoutesMock.mockResolvedValueOnce([]);

    const result = await syncGuardRoutesToProber('proj_1');
    expect(result).toEqual({ synced: 0, candidates: 0 });
    expect(seedProberTargetsMock).not.toHaveBeenCalled();
    expect(upgradeProberTargetSourceMock).not.toHaveBeenCalled();
  });

  it('syncs only GET routes that need a session and ignores mutations / public routes', async () => {
    listGuardRoutesMock.mockResolvedValueOnce([
      // Protected GET route (98% with session) → should sync
      {
        id: 'r1',
        pattern: '/admin/settings',
        method: 'GET',
        kind: 'route',
        withSession: 98,
        withoutSession: 2,
      },
      // Server action (mutation) → should NOT sync to prober
      {
        id: 'r2',
        pattern: '/api/update-profile',
        method: 'POST',
        kind: 'server_action',
        withSession: 100,
        withoutSession: 0,
      },
      // Mutation HTTP method (POST) → should NOT sync
      {
        id: 'r3',
        pattern: '/api/orders',
        method: 'POST',
        kind: 'route',
        withSession: 50,
        withoutSession: 0,
      },
      // Public route (mostly without session) → should NOT sync
      {
        id: 'r4',
        pattern: '/blog/[id]',
        method: 'GET',
        kind: 'route',
        withSession: 5,
        withoutSession: 95,
      },
    ]);

    const result = await syncGuardRoutesToProber('proj_1');

    expect(result).toEqual({ synced: 1, candidates: 4 });
    expect(seedProberTargetsMock).toHaveBeenCalledWith('proj_1', [
      { path: '/admin/settings', method: 'GET', source: 'guard' },
    ]);
    expect(upgradeProberTargetSourceMock).toHaveBeenCalledWith('proj_1', [
      { path: '/admin/settings', method: 'GET', source: 'guard' },
    ]);
  });

  it('caps synced routes to 50 for politeness', async () => {
    const manyRoutes = Array.from({ length: 60 }, (_, i) => ({
      id: `r_${i}`,
      pattern: `/dashboard/item/${i}`,
      method: 'GET',
      kind: 'route',
      withSession: 10,
      withoutSession: 0,
    }));

    listGuardRoutesMock.mockResolvedValueOnce(manyRoutes);

    const result = await syncGuardRoutesToProber('proj_1');
    expect(result.synced).toBe(50);
    expect(result.candidates).toBe(60);
    expect(seedProberTargetsMock).toHaveBeenCalledWith(
      'proj_1',
      expect.arrayContaining([expect.objectContaining({ source: 'guard' })]),
    );
  });

  it('strictly ignores source=sample routes even if session ratio is 100%', async () => {
    listGuardRoutesMock.mockResolvedValueOnce([
      // Sample route with 100% session ratio -> MUST NOT sync to prober
      {
        id: 'r_sample',
        pattern: '/dashboard/sample-secret',
        method: 'GET',
        kind: 'route',
        source: 'sample',
        withSession: 100,
        withoutSession: 0,
      },
      // Real route (source: null) with 100% session ratio -> should sync
      {
        id: 'r_real',
        pattern: '/dashboard/real-secret',
        method: 'GET',
        kind: 'route',
        source: null,
        withSession: 50,
        withoutSession: 0,
      },
    ]);

    const result = await syncGuardRoutesToProber('proj_1');
    expect(result.synced).toBe(1);
    expect(seedProberTargetsMock).toHaveBeenCalledWith('proj_1', [
      { path: '/dashboard/real-secret', method: 'GET', source: 'guard' },
    ]);
  });

  it('stale route (last_seen_at > 14 days) + needsSession → no new target inserted', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const staleDate = new Date('2026-08-20T12:00:00.000Z'); // 23 days ago (> 14 days)

    listGuardRoutesMock.mockResolvedValueOnce([
      {
        id: 'r_stale',
        pattern: '/admin/stale-feature',
        method: 'GET',
        kind: 'route',
        source: null,
        lastSeenAt: staleDate,
        withSession: 100,
        withoutSession: 0,
      },
    ]);

    const result = await syncGuardRoutesToProber('proj_1', { now });

    expect(result).toEqual({ synced: 0, candidates: 0 });
    expect(seedProberTargetsMock).not.toHaveBeenCalled();
    expect(upgradeProberTargetSourceMock).not.toHaveBeenCalled();
  });

  it('syncs fresh routes while skipping stale routes, leaving existing targets untouched', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const staleDate = new Date('2026-08-25T12:00:00.000Z'); // 18 days ago (> 14 days)
    const freshDate = new Date('2026-09-10T12:00:00.000Z'); // 2 days ago (<= 14 days)

    listGuardRoutesMock.mockResolvedValueOnce([
      // Stale route
      {
        id: 'r_stale',
        pattern: '/admin/stale-feature',
        method: 'GET',
        kind: 'route',
        source: null,
        lastSeenAt: staleDate,
        withSession: 100,
        withoutSession: 0,
      },
      // Fresh route
      {
        id: 'r_fresh',
        pattern: '/admin/fresh-feature',
        method: 'GET',
        kind: 'route',
        source: null,
        lastSeenAt: freshDate,
        withSession: 100,
        withoutSession: 0,
      },
    ]);

    const result = await syncGuardRoutesToProber('proj_1', { now });

    expect(result.synced).toBe(1);
    expect(seedProberTargetsMock).toHaveBeenCalledWith('proj_1', [
      { path: '/admin/fresh-feature', method: 'GET', source: 'guard' },
    ]);
    expect(upgradeProberTargetSourceMock).toHaveBeenCalledWith('proj_1', [
      { path: '/admin/fresh-feature', method: 'GET', source: 'guard' },
    ]);
  });
});

describe('isRouteFresh', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');

  it('returns true for routes seen within 14 days', () => {
    const justNow = new Date('2026-09-12T11:59:00.000Z');
    const twoDaysAgo = new Date('2026-09-10T12:00:00.000Z');
    const exactly14DaysAgo = new Date('2026-08-29T12:00:00.000Z');

    expect(isRouteFresh(justNow, now)).toBe(true);
    expect(isRouteFresh(twoDaysAgo, now)).toBe(true);
    expect(isRouteFresh(exactly14DaysAgo, now)).toBe(true);
  });

  it('returns false for routes seen more than 14 days ago', () => {
    const fifteenDaysAgo = new Date('2026-08-28T11:59:59.000Z');
    const monthAgo = new Date('2026-08-12T12:00:00.000Z');

    expect(isRouteFresh(fifteenDaysAgo, now)).toBe(false);
    expect(isRouteFresh(monthAgo, now)).toBe(false);
  });

  it('handles null, undefined, or string inputs gracefully', () => {
    expect(isRouteFresh(undefined, now)).toBe(true);
    expect(isRouteFresh(null, now)).toBe(true);
    expect(isRouteFresh('2026-09-10T12:00:00.000Z', now)).toBe(true);
    expect(isRouteFresh('2026-08-01T12:00:00.000Z', now)).toBe(false);
  });
});

