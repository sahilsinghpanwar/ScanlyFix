import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockInsert = vi.fn(() => ({
  values: (...args: unknown[]) => {
    mockValues(...args);
    return {
      returning: mockReturning,
      onConflictDoUpdate: mockOnConflictDoUpdate,
      onConflictDoNothing: mockOnConflictDoNothing,
    };
  },
}));

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock('../src/client.ts', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

import {
  addProberTarget,
  countManualProberTargets,
  getProberTarget,
  seedProberTargets,
} from '../src/queries/runtime-prober.ts';

describe('packages/db runtime-prober-targets queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addProberTarget', () => {
    it('enforces method === "GET" and rejects non-GET methods', async () => {
      await expect(addProberTarget('proj-1', '/api/users', 'POST')).rejects.toThrow(
        /Only GET method is supported for prober targets/,
      );
      await expect(addProberTarget('proj-1', '/api/users', 'DELETE')).rejects.toThrow(
        /Only GET method is supported for prober targets/,
      );
      await expect(addProberTarget('proj-1', '/api/users', 'PUT')).rejects.toThrow(
        /Only GET method is supported for prober targets/,
      );
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('inserts GET target and normalizes path with leading slash', async () => {
      mockReturning.mockResolvedValueOnce([{ id: 'target-1', path: '/admin', method: 'GET' }]);
      mockOnConflictDoUpdate.mockReturnValueOnce({ returning: mockReturning });

      const res = await addProberTarget('proj-1', 'admin', 'get', 'manual');
      expect(res).toEqual({ id: 'target-1', path: '/admin', method: 'GET' });
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          path: '/admin',
          method: 'GET',
          source: 'manual',
        }),
      );
    });
  });

  describe('countManualProberTargets', () => {
    it('returns the count of manual prober targets', async () => {
      mockWhere.mockResolvedValueOnce([{ n: 12 }]);

      const count = await countManualProberTargets('proj-1');
      expect(count).toBe(12);
      expect(mockSelect).toHaveBeenCalled();
    });

    it('returns 0 when no rows are found', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const count = await countManualProberTargets('proj-1');
      expect(count).toBe(0);
    });
  });

  describe('getProberTarget', () => {
    it('queries single target by normalized path and method', async () => {
      mockLimit.mockResolvedValueOnce([{ id: 'target-1', path: '/dashboard', method: 'GET' }]);

      const target = await getProberTarget('proj-1', 'dashboard', 'GET');
      expect(target).toEqual({ id: 'target-1', path: '/dashboard', method: 'GET' });
    });

    it('returns null when target does not exist', async () => {
      mockLimit.mockResolvedValueOnce([]);

      const target = await getProberTarget('proj-1', '/nonexistent', 'GET');
      expect(target).toBeNull();
    });
  });

  describe('seedProberTargets', () => {
    it('filters out any non-GET targets and inserts only GET targets', async () => {
      mockOnConflictDoNothing.mockResolvedValueOnce(undefined);

      await seedProberTargets('proj-1', [
        { path: '/login', method: 'GET', source: 'default' },
        { path: '/api/checkout', method: 'POST', source: 'default' },
        { path: '/admin', method: 'GET', source: 'default' },
      ]);

      expect(mockValues).toHaveBeenCalledWith([
        { projectId: 'proj-1', path: '/login', method: 'GET', source: 'default' },
        { projectId: 'proj-1', path: '/admin', method: 'GET', source: 'default' },
      ]);
    });

    it('does not insert if all targets are non-GET or array is empty', async () => {
      await seedProberTargets('proj-1', [
        { path: '/api/checkout', method: 'POST', source: 'default' },
      ]);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});
