import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock DB client
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockInsert = vi.fn(() => ({
  values: (...args: unknown[]) => {
    mockValues(...args);
    return {
      returning: mockReturning,
      onConflictDoNothing: mockOnConflictDoNothing,
      onConflictDoUpdate: mockOnConflictDoUpdate,
    };
  },
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

const mockExecute = vi.fn();

vi.mock('../src/client.ts', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    execute: (...args: unknown[]) => mockExecute(...args),
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
  purgeOldAiCallsBatch,
  getModelPricingCatalog,
  upsertModelPricingCatalog,
  getSpendHourlyBuckets,
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
          source: null,
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
          source: null,
        },
      ]);
    });

    it('records events with source=sample for test calls', async () => {
      mockReturning.mockResolvedValueOnce([{ id: 'uuid-sample' }]);
      mockValues.mockReturnValueOnce({ returning: mockReturning });

      await recordAiCallEvents('proj-1', [
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          promptTokens: 100,
          completionTokens: 50,
          costMicroUsd: 45,
          source: 'sample',
        },
      ]);

      expect(mockValues).toHaveBeenCalledWith([
        expect.objectContaining({
          projectId: 'proj-1',
          source: 'sample',
        }),
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

  describe('purgeOldAiCallsBatch', () => {
    it('deletes rows in batch and stops if count < batchSize', async () => {
      mockExecute.mockResolvedValueOnce({ rowCount: 150 });

      const cutoff = new Date('2025-01-01T00:00:00Z');
      const total = await purgeOldAiCallsBatch(cutoff, 1000);

      expect(total).toBe(150);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('loops until a batch returns fewer rows than batchSize', async () => {
      // First iteration deletes 10_000, second deletes 4_200 (< 10_000, stops)
      mockExecute
        .mockResolvedValueOnce({ rowCount: 10_000 })
        .mockResolvedValueOnce({ rowCount: 4_200 });

      const cutoff = new Date('2025-01-01T00:00:00Z');
      const total = await purgeOldAiCallsBatch(cutoff, 10_000);

      expect(total).toBe(14_200);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('handles zero deleted rows cleanly', async () => {
      mockExecute.mockResolvedValueOnce({ rowCount: 0 });

      const cutoff = new Date('2025-01-01T00:00:00Z');
      const total = await purgeOldAiCallsBatch(cutoff, 10_000);

      expect(total).toBe(0);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('handles array returns from mock/driver', async () => {
      mockExecute.mockResolvedValueOnce([{ id: 'row-1' }, { id: 'row-2' }]);

      const cutoff = new Date('2025-01-01T00:00:00Z');
      const total = await purgeOldAiCallsBatch(cutoff, 100);

      expect(total).toBe(2);
    });
  });

  describe('getModelPricingCatalog & upsertModelPricingCatalog', () => {
    it('returns catalog array when row exists', async () => {
      const mockCatalog = [{ model: 'gpt-4o', inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 }];
      mockSelectLimit.mockResolvedValueOnce([{ catalog: mockCatalog }]);
      mockSelectWhere.mockReturnValueOnce({ limit: mockSelectLimit });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const res = await getModelPricingCatalog();
      expect(res).toEqual(mockCatalog);
    });

    it('returns null when no catalog row exists', async () => {
      mockSelectLimit.mockResolvedValueOnce([]);
      mockSelectWhere.mockReturnValueOnce({ limit: mockSelectLimit });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const res = await getModelPricingCatalog();
      expect(res).toBeNull();
    });

    it('upsertModelPricingCatalog performs onConflictDoUpdate on id=litellm', async () => {
      mockOnConflictDoUpdate.mockResolvedValueOnce(undefined);
      const catalog = [{ model: 'claude-3-opus', inputUsdPerMillion: 15, outputUsdPerMillion: 75 }];
      const date = new Date('2026-09-12T00:00:00Z');

      await upsertModelPricingCatalog(catalog, date);

      expect(mockValues).toHaveBeenCalledWith({
        id: 'litellm',
        catalog,
        entryCount: 1,
        fetchedAt: date,
      });
      expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSpendHourlyBuckets', () => {
    it('returns exactly 24 continuous hourly buckets, mapping DB results and zeroing gaps', async () => {
      const fixedNow = new Date('2026-09-12T15:30:00Z');
      const activeHour = new Date('2026-09-12T12:00:00Z').toISOString();

      mockSelectGroupBy.mockResolvedValueOnce([
        {
          bucketHour: activeHour,
          calls: '5',
          costMicroUsd: '250000',
        },
      ]);
      mockSelectWhere.mockReturnValueOnce({ groupBy: mockSelectGroupBy });
      mockSelectFrom.mockReturnValueOnce({ where: mockSelectWhere });
      mockSelect.mockReturnValueOnce({ from: mockSelectFrom });

      const buckets = await getSpendHourlyBuckets('p-buckets', 24, fixedNow);

      expect(buckets).toHaveLength(24);

      // Chronological order: first bucket should be 23 hours before current hour (15:00 - 23h = yesterday 16:00)
      expect(buckets[0].hour).toBe(new Date('2026-09-11T16:00:00Z').toISOString());
      // Last bucket should be the current hour (15:00)
      expect(buckets[23].hour).toBe(new Date('2026-09-12T15:00:00Z').toISOString());

      // Active hour should have the aggregated data
      const active = buckets.find((b) => b.hour === activeHour);
      expect(active).toBeDefined();
      expect(active?.costMicroUsd).toBe(250_000);
      expect(active?.calls).toBe(5);

      // Inactive hour should have 0
      const inactive = buckets.find((b) => b.hour !== activeHour);
      expect(inactive?.costMicroUsd).toBe(0);
      expect(inactive?.calls).toBe(0);
    });
  });
});
