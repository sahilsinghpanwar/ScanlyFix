import { describe, expect, it, vi, beforeEach } from 'vitest';
import { retentionCutoff, isDailyRetentionDue, sweepMonitors } from '../inngest/functions/sweep.ts';

vi.mock('@scanlyfix/db', () => ({
  claimDueMonitors: vi.fn().mockResolvedValue([]),
  purgeOldAiCallsBatch: vi.fn().mockResolvedValue(150),
  purgeExpiredRuntimeSecrets: vi.fn().mockResolvedValue(5),
}));

describe('Retention Cutoff & Sweep Logic', () => {
  describe('retentionCutoff (pure function)', () => {
    it('calculates cutoff exactly 90 days in the past by default', () => {
      const now = new Date('2026-06-01T12:00:00.000Z');
      const cutoff = retentionCutoff(now);

      const diffMs = now.getTime() - cutoff.getTime();
      const expectedDiffMs = 90 * 24 * 60 * 60 * 1000; // 7,776,000,000 ms
      expect(diffMs).toBe(expectedDiffMs);
      expect(cutoff.toISOString()).toBe('2026-03-03T12:00:00.000Z');
    });

    it('does not mutate the input Date object', () => {
      const now = new Date('2026-06-01T12:00:00.000Z');
      const originalTime = now.getTime();
      retentionCutoff(now);
      expect(now.getTime()).toBe(originalTime);
    });

    it('supports custom days parameter', () => {
      const now = new Date('2026-06-01T12:00:00.000Z');
      const cutoff30 = retentionCutoff(now, 30);
      expect(now.getTime() - cutoff30.getTime()).toBe(30 * 24 * 60 * 60 * 1000);

      const cutoff1 = retentionCutoff(now, 1);
      expect(now.getTime() - cutoff1.getTime()).toBe(1 * 24 * 60 * 60 * 1000);
      expect(cutoff1.toISOString()).toBe('2026-05-31T12:00:00.000Z');
    });

    it('accurately crosses leap days and month boundaries', () => {
      // Leap year 2024: Feb has 29 days
      const now = new Date('2024-03-05T00:00:00.000Z');
      const cutoff = retentionCutoff(now, 10); // 10 days before March 5, 2024 is Feb 24, 2024
      expect(cutoff.toISOString()).toBe('2024-02-24T00:00:00.000Z');
    });

    it('produces identical output given the same input (idempotent / pure)', () => {
      const now = new Date('2026-09-12T00:00:00.000Z');
      const cutoff1 = retentionCutoff(now, 90);
      const cutoff2 = retentionCutoff(now, 90);
      expect(cutoff1.getTime()).toBe(cutoff2.getTime());
    });
  });

  describe('isDailyRetentionDue predicate', () => {
    it('returns true exactly at 03:00 UTC', () => {
      const dueTime = new Date('2026-09-12T03:00:00.000Z');
      expect(isDailyRetentionDue(dueTime)).toBe(true);
    });

    it('returns false at any other UTC hour or minute', () => {
      expect(isDailyRetentionDue(new Date('2026-09-12T03:01:00.000Z'))).toBe(false);
      expect(isDailyRetentionDue(new Date('2026-09-12T02:00:00.000Z'))).toBe(false);
      expect(isDailyRetentionDue(new Date('2026-09-12T04:00:00.000Z'))).toBe(false);
      expect(isDailyRetentionDue(new Date('2026-09-12T12:30:00.000Z'))).toBe(false);
    });
  });

  describe('sweepMonitors Inngest function execution', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('skips the retention step when not due (e.g. 10:15 UTC)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-12T10:15:00.000Z'));

      const executedSteps: string[] = [];
      const mockStep = {
        run: vi.fn(async (name: string, fn: () => unknown) => {
          executedSteps.push(name);
          return fn();
        }),
        sendEvent: vi.fn(),
      };

      const fn = (sweepMonitors as unknown as { fn: (ctx: { step: typeof mockStep }) => Promise<unknown> }).fn;
      const result = await fn({ step: mockStep });

      expect(executedSteps).toContain('claim-batch');
      expect(executedSteps).not.toContain('purge-expired-ai-calls');
      expect(executedSteps).not.toContain('purge-expired-runtime-secrets');
      expect(result).toEqual({ dispatched: 0, aiCallsPurged: 0, expiredSecretsPurged: 0 });

      vi.useRealTimers();
    });

    it('executes the retention step when due at 03:00 UTC with 90-day cutoff and 10,000 batch size', async () => {
      const { purgeOldAiCallsBatch, purgeExpiredRuntimeSecrets } = await import('@scanlyfix/db');
      vi.useFakeTimers();
      const fixedTime = new Date('2026-09-12T03:00:00.000Z');
      vi.setSystemTime(fixedTime);

      const executedSteps: string[] = [];
      const mockStep = {
        run: vi.fn(async (name: string, fn: () => unknown) => {
          executedSteps.push(name);
          return fn();
        }),
        sendEvent: vi.fn(),
      };

      const fn = (sweepMonitors as unknown as { fn: (ctx: { step: typeof mockStep }) => Promise<unknown> }).fn;
      const result = await fn({ step: mockStep });

      expect(executedSteps).toContain('claim-batch');
      expect(executedSteps).toContain('purge-expired-ai-calls');
      expect(executedSteps).toContain('purge-expired-runtime-secrets');
      expect(result).toEqual({ dispatched: 0, aiCallsPurged: 150, expiredSecretsPurged: 5 });

      const expectedCutoff = retentionCutoff(fixedTime, 90);
      expect(purgeOldAiCallsBatch).toHaveBeenCalledWith(expectedCutoff, 10_000);

      const expectedGraceCutoff = new Date(fixedTime.getTime() - 24 * 3600_000);
      expect(purgeExpiredRuntimeSecrets).toHaveBeenCalledWith(expectedGraceCutoff);

      vi.useRealTimers();
    });
  });
});
