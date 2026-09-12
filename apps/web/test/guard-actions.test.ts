import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireUserMock = vi.fn();
vi.mock('../lib/authz.ts', () => ({
  requireUser: (...args: unknown[]) => requireUserMock(...args),
}));

const getProjectMock = vi.fn();
const clearGuardRoutesMock = vi.fn();
vi.mock('@scanlyfix/db', () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
  clearGuardRoutes: (...args: unknown[]) => clearGuardRoutesMock(...args),
}));

const syncGuardRoutesToProberMock = vi.fn();
vi.mock('../lib/runtime/guard/sync.ts', () => ({
  syncGuardRoutesToProber: (...args: unknown[]) => syncGuardRoutesToProberMock(...args),
}));

const revalidatePathMock = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

import { refreshGuardAction, clearGuardRoutesAction } from '../app/(app)/runtime/guard/actions.ts';

describe('refreshGuardAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found if user does not own the project', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce(null);

    const result = await refreshGuardAction('proj_other');
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(syncGuardRoutesToProberMock).not.toHaveBeenCalled();
  });

  it('syncs routes and revalidates runtime paths when authorized', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce({ id: 'proj_1', name: 'My App' });
    syncGuardRoutesToProberMock.mockResolvedValueOnce({ synced: 4, candidates: 10 });

    const result = await refreshGuardAction('proj_1');
    expect(result).toEqual({ ok: true, syncedTargets: 4 });
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/guard');
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime');
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/probers');
  });

  it('handles unexpected errors gracefully', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('unauthenticated'));

    const result = await refreshGuardAction('proj_1');
    expect(result).toEqual({ ok: false, error: 'refresh_failed' });
  });
});

describe('clearGuardRoutesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found if user does not own the project', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce(null);

    const result = await clearGuardRoutesAction('proj_other', 'CLEAR');
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(clearGuardRoutesMock).not.toHaveBeenCalled();
  });

  it('requires typed confirmation (returns confirmation_required on mismatch)', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce({ id: 'proj_1', name: 'My App' });

    // Missing confirmation
    const res1 = await clearGuardRoutesAction('proj_1');
    expect(res1).toEqual({ ok: false, error: 'confirmation_required' });

    // Wrong confirmation text
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce({ id: 'proj_1', name: 'My App' });
    const res2 = await clearGuardRoutesAction('proj_1', 'WRONG');
    expect(res2).toEqual({ ok: false, error: 'confirmation_required' });

    expect(clearGuardRoutesMock).not.toHaveBeenCalled();
  });

  it('deletes routes and targets and returns deleted counts when confirmation matches', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce({ id: 'proj_1', name: 'My App' });
    clearGuardRoutesMock.mockResolvedValueOnce({ deletedRoutes: 12, deletedTargets: 4 });

    const result = await clearGuardRoutesAction('proj_1', 'CLEAR');

    expect(result).toEqual({ ok: true, deletedRoutes: 12, deletedTargets: 4 });
    expect(clearGuardRoutesMock).toHaveBeenCalledWith('proj_1');
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/guard');
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime');
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/probers');
  });
});

