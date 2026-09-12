import { describe, expect, it } from 'vitest';
import {
  calculateBaselineAgeDays,
  detectFlappingPaths,
  isPathUnstable,
  type FindingHistoryItem,
} from '../lib/runtime/auth-prober/flap.ts';

describe('Auth Prober — Flap Detection & Baseline Age', () => {
  describe('calculateBaselineAgeDays', () => {
    const fixedNow = new Date('2026-09-15T12:00:00Z');

    it('returns null when baselineAt is null or undefined or invalid', () => {
      expect(calculateBaselineAgeDays(null, fixedNow)).toBeNull();
      expect(calculateBaselineAgeDays(undefined, fixedNow)).toBeNull();
      expect(calculateBaselineAgeDays('invalid-date', fixedNow)).toBeNull();
    });

    it('returns 0 when baseline was recorded on the same day', () => {
      const sameDay = new Date('2026-09-15T08:00:00Z');
      expect(calculateBaselineAgeDays(sameDay, fixedNow)).toBe(0);
    });

    it('returns correct day count for recent baselines', () => {
      const fiveDaysAgo = new Date('2026-09-10T12:00:00Z');
      expect(calculateBaselineAgeDays(fiveDaysAgo, fixedNow)).toBe(5);

      const sixtyDaysAgo = new Date('2026-07-17T12:00:00Z');
      expect(calculateBaselineAgeDays(sixtyDaysAgo, fixedNow)).toBe(60);
    });

    it('correctly calculates age when > 180 days (re-record suggestion threshold)', () => {
      const oneHundredEightyOneDaysAgo = new Date('2026-03-18T12:00:00Z');
      const age = calculateBaselineAgeDays(oneHundredEightyOneDaysAgo, fixedNow);
      expect(age).toBeGreaterThan(180);
    });
  });

  describe('detectFlappingPaths pure function', () => {
    const now = new Date('2026-09-15T00:00:00Z');
    const day = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

    it('returns empty results for empty findings history', () => {
      const result = detectFlappingPaths([], { now });
      expect(result.unstablePaths.size).toBe(0);
      expect(result.isUnstable('/admin')).toBe(false);
      expect(result.getFlapStatus('/admin')).toBe('stable');
    });

    it('returns stable when path regressed only 1 or 2 times within 30 days', () => {
      const findings: FindingHistoryItem[] = [
        { path: '/admin', createdAt: day(5) },
        { path: '/admin', createdAt: day(15) },
      ];

      const result = detectFlappingPaths(findings, { now });
      expect(result.regressionCounts['/admin']).toBe(2);
      expect(result.unstablePaths.has('/admin')).toBe(false);
      expect(result.isUnstable('/admin')).toBe(false);
      expect(result.getFlapStatus('/admin')).toBe('stable');
    });

    it('returns unstable flag when path regressed >= 3 times within 30 days', () => {
      const findings: FindingHistoryItem[] = [
        { path: '/api/v1/keys', createdAt: day(2) },
        { path: '/api/v1/keys', createdAt: day(10) },
        { path: '/api/v1/keys', createdAt: day(22) },
      ];

      const result = detectFlappingPaths(findings, { now });
      expect(result.regressionCounts['/api/v1/keys']).toBe(3);
      expect(result.unstablePaths.has('/api/v1/keys')).toBe(true);
      expect(result.isUnstable('/api/v1/keys')).toBe(true);
      expect(result.getFlapStatus('/api/v1/keys')).toBe('unstable');
    });

    it('does NOT count regressions older than 30 days towards the threshold', () => {
      const findings: FindingHistoryItem[] = [
        { path: '/admin', createdAt: day(3) },
        { path: '/admin', createdAt: day(14) },
        // These 2 regressions are outside the 30-day window
        { path: '/admin', createdAt: day(32) },
        { path: '/admin', createdAt: day(45) },
      ];

      const result = detectFlappingPaths(findings, { now });
      // Only 2 in 30-day window
      expect(result.regressionCounts['/admin']).toBe(2);
      expect(result.unstablePaths.has('/admin')).toBe(false);
      expect(result.isUnstable('/admin')).toBe(false);
    });

    it('distinguishes between stable and unstable paths across history', () => {
      const findings: FindingHistoryItem[] = [
        // /admin regressed 3 times in 30d -> unstable
        { path: '/admin', createdAt: day(1) },
        { path: '/admin', createdAt: day(10) },
        { path: '/admin', createdAt: day(20) },

        // /dashboard regressed 2 times in 30d -> stable
        { path: '/dashboard', createdAt: day(5) },
        { path: '/dashboard', createdAt: day(15) },

        // /api/settings regressed once -> stable
        { path: '/api/settings', createdAt: day(8) },
      ];

      const result = detectFlappingPaths(findings, { now });
      expect(result.unstablePaths.has('/admin')).toBe(true);
      expect(result.unstablePaths.has('/dashboard')).toBe(false);
      expect(result.unstablePaths.has('/api/settings')).toBe(false);
      expect(result.isUnstable('/admin')).toBe(true);
      expect(result.isUnstable('/dashboard')).toBe(false);
    });

    it('supports custom windowDays and threshold options', () => {
      const findings: FindingHistoryItem[] = [
        { path: '/api/custom', createdAt: day(2) },
        { path: '/api/custom', createdAt: day(4) },
      ];

      // With threshold=2, 2 events is enough
      const resultCustom = detectFlappingPaths(findings, { now, threshold: 2 });
      expect(resultCustom.isUnstable('/api/custom')).toBe(true);

      // With narrow windowDays=3, day(4) is excluded
      const resultNarrow = detectFlappingPaths(findings, { now, windowDays: 3, threshold: 2 });
      expect(resultNarrow.isUnstable('/api/custom')).toBe(false);
    });

    it('isPathUnstable helper accurately reflects status', () => {
      const findings: FindingHistoryItem[] = [
        { path: '/flapping', createdAt: day(1) },
        { path: '/flapping', createdAt: day(2) },
        { path: '/flapping', createdAt: day(3) },
      ];

      expect(isPathUnstable('/flapping', findings, { now })).toBe(true);
      expect(isPathUnstable('/calm', findings, { now })).toBe(false);
    });
  });
});
