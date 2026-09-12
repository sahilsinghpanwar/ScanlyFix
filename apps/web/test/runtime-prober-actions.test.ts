import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireUserMock = vi.fn();
vi.mock('@/lib/authz', () => ({
  requireUser: (...args: unknown[]) => requireUserMock(...args),
}));

const getProjectMock = vi.fn();
const addProberTargetMock = vi.fn();
const deleteProberTargetMock = vi.fn();
const getRuntimeProjectContextMock = vi.fn();
const resolveFindingManuallyMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
  addProberTarget: (...args: unknown[]) => addProberTargetMock(...args),
  deleteProberTarget: (...args: unknown[]) => deleteProberTargetMock(...args),
  getRuntimeProjectContext: (...args: unknown[]) => getRuntimeProjectContextMock(...args),
  resolveFindingManually: (...args: unknown[]) => resolveFindingManuallyMock(...args),
  getProjectOwnerEmail: vi.fn().mockResolvedValue('owner@example.com'),
}));

const runAuthProberMock = vi.fn();
vi.mock('@/lib/runtime/auth-prober', () => ({
  runAuthProber: (...args: unknown[]) => runAuthProberMock(...args),
}));

vi.mock('@/lib/runtime/auth-prober/alert', () => ({
  buildProberAlertEmail: vi.fn().mockReturnValue({ subject: 'alert', text: 'body' }),
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

const revalidatePathMock = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

import {
  addTargetAction,
  deleteTargetAction,
  resolveFindingAction,
  runProberAction,
} from '../app/(app)/runtime/probers/action.ts';

describe('runtime prober actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addTargetAction', () => {
    it('validates path begins with /', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });

      const res = await addTargetAction('proj_1', 'no-slash');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: expect.stringContaining('must start with /') });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('adds custom target and revalidates paths', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      addProberTargetMock.mockResolvedValueOnce({ id: 't_custom', path: '/api/secret' });

      const res = await addTargetAction('proj_1', '/api/secret');
      expect(res.ok).toBe(true);
      expect(addProberTargetMock).toHaveBeenCalledWith('proj_1', '/api/secret', 'GET', 'manual');
      expect(revalidatePathMock).toHaveBeenCalledWith('/runtime');
      expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/probers');
    });
  });

  describe('deleteTargetAction', () => {
    it('deletes target and revalidates paths', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      deleteProberTargetMock.mockResolvedValueOnce(true);

      const res = await deleteTargetAction('proj_1', 't_1');
      expect(res.ok).toBe(true);
      expect(deleteProberTargetMock).toHaveBeenCalledWith('proj_1', 't_1');
      expect(revalidatePathMock).toHaveBeenCalledWith('/runtime');
    });
  });

  describe('runProberAction', () => {
    it('returns friendly summary data after probe execution', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      getRuntimeProjectContextMock.mockResolvedValueOnce({ id: 'proj_1', isVerified: true, hostname: 'example.com' });
      runAuthProberMock.mockResolvedValueOnce({
        checked: 16,
        baselinesRecorded: 16,
        newFindings: 0,
        autoResolved: 0,
        stillOpen: 0,
        errors: 0,
      });

      const res = await runProberAction('proj_1');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.summary?.baselinesRecorded).toBe(16);
        expect(res.message).toContain('Recorded baselines for 16 target(s)');
      }
      expect(revalidatePathMock).toHaveBeenCalledWith('/runtime');
    });

    it('rejects if domain is not verified', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      getRuntimeProjectContextMock.mockResolvedValueOnce({ id: 'proj_1', isVerified: false, hostname: 'example.com' });

      const res = await runProberAction('proj_1');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: 'verify_domain_first' });
    });
  });

  describe('resolveFindingAction', () => {
    it('resolves finding manually', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      resolveFindingManuallyMock.mockResolvedValueOnce(undefined);

      const res = await resolveFindingAction('proj_1', 'f_1');
      expect(res.ok).toBe(true);
      expect(resolveFindingManuallyMock).toHaveBeenCalledWith('f_1', 'proj_1');
    });
  });
});
