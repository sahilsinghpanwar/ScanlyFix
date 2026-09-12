import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockSelect: ReturnType<typeof vi.fn>;
let mockFrom: ReturnType<typeof vi.fn>;
let mockWhere: ReturnType<typeof vi.fn>;
let mockLimit: ReturnType<typeof vi.fn>;
let mockUpdate: ReturnType<typeof vi.fn>;
let mockSet: ReturnType<typeof vi.fn>;
let mockUpdateWhere: ReturnType<typeof vi.fn>;
let mockReturning: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();

  mockLimit = vi.fn(() => Promise.resolve([]));
  mockWhere = vi.fn(() => ({ limit: mockLimit }));
  mockFrom = vi.fn(() => ({ where: mockWhere }));
  mockSelect = vi.fn(() => ({ from: mockFrom }));

  mockReturning = vi.fn(() => Promise.resolve([]));
  mockUpdateWhere = vi.fn(() => ({ returning: mockReturning }));
  mockSet = vi.fn(() => ({ where: mockUpdateWhere }));
  mockUpdate = vi.fn(() => ({ set: mockSet }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/client.ts');
});

describe('Task 6 — Secret Rotation Grace Window', () => {
  const CURRENT_SECRET = 'curr_sec_11111111111111111111111111111111';
  const PREV_SECRET = 'prev_sec_00000000000000000000000000000000';

  describe('getProjectRuntimeAuthSecrets', () => {
    it('returns empty validSecrets when project has no secret set', async () => {
      mockLimit.mockResolvedValueOnce([]);
      vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }));

      const { getProjectRuntimeAuthSecrets } = await import('../src/queries/projects.ts');
      const result = await getProjectRuntimeAuthSecrets('proj_none');

      expect(result).toEqual({ current: null, prev: null, rotatedAt: null, validSecrets: [] });
    });

    it('returns only current secret when no rotation has occurred (prev is null)', async () => {
      mockLimit.mockResolvedValueOnce([
        { current: CURRENT_SECRET, prev: null, rotatedAt: null },
      ]);
      vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }));

      const { getProjectRuntimeAuthSecrets } = await import('../src/queries/projects.ts');
      const result = await getProjectRuntimeAuthSecrets('proj_normal');

      expect(result.current).toBe(CURRENT_SECRET);
      expect(result.prev).toBeNull();
      expect(result.validSecrets).toEqual([CURRENT_SECRET]);
    });

    it('accepts BOTH current and prev secrets within 24h grace window', async () => {
      const now = new Date('2026-09-12T12:00:00.000Z');
      const rotatedAt = new Date('2026-09-12T08:00:00.000Z'); // 4 hours ago (within 24h)

      mockLimit.mockResolvedValueOnce([
        { current: CURRENT_SECRET, prev: PREV_SECRET, rotatedAt },
      ]);
      vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }));

      const { getProjectRuntimeAuthSecrets } = await import('../src/queries/projects.ts');
      const result = await getProjectRuntimeAuthSecrets('proj_rotated', now);

      expect(result.current).toBe(CURRENT_SECRET);
      expect(result.prev).toBe(PREV_SECRET);
      expect(result.validSecrets).toEqual([CURRENT_SECRET, PREV_SECRET]);
    });

    it('rejects prev secret after 24h grace window (only current is valid)', async () => {
      const now = new Date('2026-09-12T12:00:00.000Z');
      const rotatedAt = new Date('2026-09-11T11:00:00.000Z'); // 25 hours ago (> 24h)

      mockLimit.mockResolvedValueOnce([
        { current: CURRENT_SECRET, prev: PREV_SECRET, rotatedAt },
      ]);
      vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }));

      const { getProjectRuntimeAuthSecrets } = await import('../src/queries/projects.ts');
      const result = await getProjectRuntimeAuthSecrets('proj_expired', now);

      expect(result.current).toBe(CURRENT_SECRET);
      expect(result.prev).toBe(PREV_SECRET);
      expect(result.validSecrets).toEqual([CURRENT_SECRET]); // PREV_SECRET omitted!
    });
  });

  describe('rotateRuntimeSecret', () => {
    it('shifts current to prev and sets rotatedAt to now', async () => {
      const now = new Date('2026-09-12T15:00:00.000Z');

      // Viewer mock
      const viewer = { kind: 'user' as const, userId: 'user_1' };

      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect,
          update: mockUpdate,
          query: {
            projects: {
              findFirst: vi.fn().mockResolvedValue({ id: 'proj_1', name: 'App' }),
            },
          },
        },
      }));

      const { rotateRuntimeSecret } = await import('../src/queries/projects.ts');

      const newSecret = await rotateRuntimeSecret('proj_1', viewer, now);

      expect(newSecret).toBeDefined();
      expect(typeof newSecret).toBe('string');
      expect(newSecret?.length).toBe(64); // 32-byte hex

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeSigningSecret: newSecret,
          runtimeSecretRotatedAt: now,
        }),
      );
    });
  });

  describe('purgeExpiredRuntimeSecrets', () => {
    it('nulls runtimeIngestSecretPrev for projects rotated before the grace cutoff', async () => {
      mockReturning.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]);
      vi.doMock('../src/client.ts', () => ({ db: { update: mockUpdate } }));

      const { purgeExpiredRuntimeSecrets } = await import('../src/queries/projects.ts');
      const graceCutoff = new Date('2026-09-11T12:00:00.000Z');

      const count = await purgeExpiredRuntimeSecrets(graceCutoff);

      expect(count).toBe(2);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith({
        runtimeIngestSecretPrev: null,
      });
    });
  });
});
