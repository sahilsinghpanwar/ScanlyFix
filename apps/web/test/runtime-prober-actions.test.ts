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
const countManualProberTargetsMock = vi.fn().mockResolvedValue(0);
const getProberTargetMock = vi.fn().mockResolvedValue(null);
const setBaselineMock = vi.fn();
const listProberTargetsMock = vi.fn().mockResolvedValue([]);

vi.mock('@scanlyfix/db', () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
  addProberTarget: (...args: unknown[]) => addProberTargetMock(...args),
  deleteProberTarget: (...args: unknown[]) => deleteProberTargetMock(...args),
  getRuntimeProjectContext: (...args: unknown[]) => getRuntimeProjectContextMock(...args),
  resolveFindingManually: (...args: unknown[]) => resolveFindingManuallyMock(...args),
  countManualProberTargets: (...args: unknown[]) => countManualProberTargetsMock(...args),
  getProberTarget: (...args: unknown[]) => getProberTargetMock(...args),
  setBaseline: (...args: unknown[]) => setBaselineMock(...args),
  listProberTargets: (...args: unknown[]) => listProberTargetsMock(...args),
  getProjectOwnerEmail: vi.fn().mockResolvedValue('owner@example.com'),
}));

import { isValidProbePath } from '../lib/runtime/auth-prober/probe.ts';

const runAuthProberMock = vi.fn();
const probeTargetMock = vi.fn();
vi.mock('@/lib/runtime/auth-prober', () => ({
  runAuthProber: (...args: unknown[]) => runAuthProberMock(...args),
  probeTarget: (...args: unknown[]) => probeTargetMock(...args),
  isValidProbePath: (path: string) => isValidProbePath(path),
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
  rerecordBaselineAction,
  resolveFindingAction,
  runProberAction,
} from '../app/(app)/runtime/probers/action.ts';

describe('runtime prober actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    countManualProberTargetsMock.mockResolvedValue(0);
    getProberTargetMock.mockResolvedValue(null);
  });

  describe('addTargetAction', () => {
    it('enforces method === "GET" and rejects non-GET methods with clear error', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });

      const res = await addTargetAction('proj_1', '/api/users', 'POST');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({
        error: expect.stringMatching(/Only GET method is supported for prober targets/i),
      });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('validates path begins with /', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });

      const res = await addTargetAction('proj_1', 'no-slash');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: expect.stringContaining('must start with /') });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('rejects path containing directory traversal (..)', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });

      const res = await addTargetAction('proj_1', '/api/../admin');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: expect.stringContaining('..') });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('rejects path containing whitespace', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });

      const res = await addTargetAction('proj_1', '/api/secret data');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: expect.stringContaining('whitespace') });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('rejects path exceeding 200 characters', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });

      const res = await addTargetAction('proj_1', '/' + 'a'.repeat(201));
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: expect.stringContaining('200 characters') });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('rejects path whose concrete length exceeds 200 characters after substitution', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });

      // Raw path length: 1 + 185 + 1 + 7 = 194 (<= 200)
      // Concrete path length: 1 + 185 + 1 + 17 = 204 (> 200)
      const longBase = '/' + 'a'.repeat(185);
      const res = await addTargetAction('proj_1', `${longBase}/[email]`);
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: expect.stringContaining('exceeds 200 characters after substitution') });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('enforces 25-manual-target cap per project for new targets', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      countManualProberTargetsMock.mockResolvedValueOnce(25);
      getProberTargetMock.mockResolvedValueOnce(null); // not already existing

      const res = await addTargetAction('proj_1', '/api/new-target');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({
        error: expect.stringContaining('25 manual targets'),
      });
      expect(addProberTargetMock).not.toHaveBeenCalled();
    });

    it('allows re-saving an existing manual target even when at 25 cap', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      countManualProberTargetsMock.mockResolvedValueOnce(25);
      getProberTargetMock.mockResolvedValueOnce({ id: 't_exist', path: '/api/existing', source: 'manual' });
      addProberTargetMock.mockResolvedValueOnce({ id: 't_exist', path: '/api/existing' });

      const res = await addTargetAction('proj_1', '/api/existing');
      expect(res.ok).toBe(true);
      expect(addProberTargetMock).toHaveBeenCalledWith('proj_1', '/api/existing', 'GET', 'manual');
    });

    it('adds custom target and revalidates paths when below cap', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      countManualProberTargetsMock.mockResolvedValueOnce(5);
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

  describe('rerecordBaselineAction', () => {
    it('probes target and updates baseline when verified', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      getRuntimeProjectContextMock.mockResolvedValueOnce({ id: 'proj_1', isVerified: true, hostname: 'example.com' });
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_1', path: '/admin' }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 403 });
      setBaselineMock.mockResolvedValueOnce(undefined);

      const res = await rerecordBaselineAction('proj_1', 't_1');
      expect(res.ok).toBe(true);
      expect(probeTargetMock).toHaveBeenCalledWith('example.com', '/admin');
      expect(setBaselineMock).toHaveBeenCalledWith('t_1', 403);
      expect(revalidatePathMock).toHaveBeenCalledWith('/runtime');
      expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/probers');
    });

    it('rejects if domain is not verified', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      getRuntimeProjectContextMock.mockResolvedValueOnce({ id: 'proj_1', isVerified: false, hostname: 'example.com' });

      const res = await rerecordBaselineAction('proj_1', 't_1');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: 'verify_domain_first' });
    });

    it('handles target not found', async () => {
      requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
      getProjectMock.mockResolvedValueOnce({ id: 'proj_1' });
      getRuntimeProjectContextMock.mockResolvedValueOnce({ id: 'proj_1', isVerified: true, hostname: 'example.com' });
      listProberTargetsMock.mockResolvedValueOnce([]);

      const res = await rerecordBaselineAction('proj_1', 't_nonexistent');
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ error: 'Target not found' });
    });
  });
});
