import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock DB client
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockInsert = vi.fn(() => ({
  values: mockValues,
}));
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdate = vi.fn(() => ({
  set: mockUpdateSet,
}));
const mockSelectLimit = vi.fn();
const mockSelectOrderBy = vi.fn();
const mockSelectGroupBy = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelect = vi.fn();

vi.mock('../src/client.ts', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

import {
  recordAiCallEvents,
  listRecentAiCalls,
  getSpendBreakdown,
  getSpendCeilingMicroUsd,
  setSpendCeiling,
  claimSpendAlertHour,
  listSpendWatchProjectIds,
} from '../src/queries/runtime-ai.ts';

describe('packages/db runtime-ai queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordAiCallEvents', () => {
    it('returns 0 immediately if events array is empty without touching db', async () => {
      const count = await recordAiCallEvents('proj-1', []);
      expect(count).toBe(0);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('sanitizes, clamps, and rounds floats and nullables', async () => {
      mockReturning.mockResolvedValueOnce([{ id: 'uuid-1' }, { id: 'uuid-2' }]);
      mockValues.mockReturnValueOnce({ returning: mockReturning });

      const count = await recordAiCallEvents('proj-1', [
        {
          provider: 'openai',
          model: 'gpt-4o',
          promptTokens: 10.7,
          completionTokens: 5.2,
          latencyMs: 120.9,
          costMicroUsd: 45.8,
          userHash: 'hash-abc',
        },
        {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          promptTokens: -5,
          completionTokens: 0,
          costMicroUsd: 0,
        },
      ]);

      expect(count).toBe(2);
      expect(mockValues).toHaveBeenCalledWith([
        {
          projectId: 'proj-1',
          provider: 'openai',
          model: 'gpt-4o',
          promptTokens: 11,
          completionTokens: 5,
          latencyMs: 121,
          costMicroUsd: 46,
          userHash: 'hash-abc',
        },
        {
          projectId: 'proj-1',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: 0,
          costMicroUsd: 0,
          userHash: null,
        },
      ]);
    });
  });

  describe('listRecentAiCalls', () => {
    it('builds select query with limit and ordering', async () => {
      mockSelectLimit.mockResolvedValueOnce([{ id: 'call-1' }]);
      mockSelectOrderBy.mockReturnValueOnce({ limit: mockSelectLimit });
      mockSelectWhere.mockReturnValueOnce({ orderBy: mockSelectOrderBy });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const res = await listRecentAiCalls('proj-1', 50);
      expect(res).toEqual([{ id: 'call-1' }]);
      expect(mockSelectLimit).toHaveBeenCalledWith(50);
    });
  });

  describe('getSpendBreakdown', () => {
    it('converts pg-driver bigint strings to numbers', async () => {
      // Setup mock chain for byModel query
      mockSelectOrderBy.mockResolvedValueOnce([
        { model: 'gpt-4o', calls: '10', costMicroUsd: '50000' },
      ]);
      mockSelectGroupBy.mockReturnValueOnce({ orderBy: mockSelectOrderBy });
      mockSelectWhere.mockReturnValueOnce({ groupBy: mockSelectGroupBy });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      // Setup mock chain for byUser query
      mockSelectLimit.mockResolvedValueOnce([
        { userHash: 'user-1', calls: '10', costMicroUsd: '50000' },
      ]);
      mockSelectOrderBy.mockReturnValueOnce({ limit: mockSelectLimit });
      mockSelectGroupBy.mockReturnValueOnce({ orderBy: mockSelectOrderBy });
      mockSelectWhere.mockReturnValueOnce({ groupBy: mockSelectGroupBy });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const breakdown = await getSpendBreakdown('proj-1', 60);
      expect(breakdown.byModel).toEqual([
        { model: 'gpt-4o', calls: 10, costMicroUsd: 50000 },
      ]);
      expect(breakdown.byUser).toEqual([
        { userHash: 'user-1', calls: 10, costMicroUsd: 50000 },
      ]);
    });
  });

  describe('getSpendCeilingMicroUsd & setSpendCeiling', () => {
    it('returns ceiling as number or null', async () => {
      mockSelectLimit.mockResolvedValueOnce([{ c: '5000000' }]);
      mockSelectWhere.mockReturnValueOnce({ limit: mockSelectLimit });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const val = await getSpendCeilingMicroUsd('proj-1');
      expect(val).toBe(5_000_000);
      expect(typeof val).toBe('number');
    });

    it('returns null when no row or null ceiling', async () => {
      mockSelectLimit.mockResolvedValueOnce([]);
      mockSelectWhere.mockReturnValueOnce({ limit: mockSelectLimit });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const val = await getSpendCeilingMicroUsd('proj-none');
      expect(val).toBeNull();
    });

    it('setSpendCeiling rounds numbers and supports null', async () => {
      mockUpdateWhere.mockResolvedValueOnce(undefined);
      mockUpdateSet.mockReturnValueOnce({ where: mockUpdateWhere });

      await setSpendCeiling('proj-1', 12345.67);
      expect(mockUpdateSet).toHaveBeenCalledWith({ runtimeSpendCeilingMicroUsd: 12346 });

      mockUpdateWhere.mockResolvedValueOnce(undefined);
      mockUpdateSet.mockReturnValueOnce({ where: mockUpdateWhere });

      await setSpendCeiling('proj-1', null);
      expect(mockUpdateSet).toHaveBeenCalledWith({ runtimeSpendCeilingMicroUsd: null });
    });
  });

  describe('claimSpendAlertHour', () => {
    it('rounds micro-USD amounts and performs conflict-free insert', async () => {
      mockReturning.mockResolvedValueOnce([{ id: 'alert-1' }]);
      mockOnConflictDoNothing.mockReturnValueOnce({ returning: mockReturning });
      mockValues.mockReturnValueOnce({ onConflictDoNothing: mockOnConflictDoNothing });

      const date = new Date('2026-03-01T12:00:00Z');
      const row = await claimSpendAlertHour('proj-1', date, 4500000.4, 5200000.9);

      expect(row).toEqual({ id: 'alert-1' });
      expect(mockValues).toHaveBeenCalledWith({
        projectId: 'proj-1',
        hour: date,
        spentMicroUsd: 4500000,
        projectedMicroUsd: 5200001,
      });
    });
  });

  describe('listSpendWatchProjectIds', () => {
    it('returns array of project id strings', async () => {
      mockSelectWhere.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]);
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const ids = await listSpendWatchProjectIds();
      expect(ids).toEqual(['p1', 'p2']);
    });
  });
});
