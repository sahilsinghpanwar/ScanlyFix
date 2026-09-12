import { describe, expect, it } from 'vitest';

import {
  computeNeedsSession,
  computeNeedsSessionFromStats,
  type RouteStatEntry,
} from '../lib/runtime/guard/heuristic.ts';

describe('computeNeedsSession', () => {
  it('sab requests session ke saath → needs session', () => {
    expect(computeNeedsSession(50, 0)).toBe(true);
  });

  it('5% tolerance ke andar → still needs session', () => {
    // 100 me se 4 bina session = 4% ≤ 5%
    expect(computeNeedsSession(96, 4)).toBe(true);
  });

  it('5% se zyada bina-session → public route', () => {
    expect(computeNeedsSession(90, 10)).toBe(false);
    expect(computeNeedsSession(0, 20)).toBe(false);
  });

  it('min samples se kam data → kabhi guess nahi', () => {
    expect(computeNeedsSession(2, 0)).toBe(false); // 2/2 = 100% with, par data kam
    expect(computeNeedsSession(0, 0)).toBe(false);
  });

  it('min samples ke exactly boundary par kaam karta hai', () => {
    expect(computeNeedsSession(3, 0)).toBe(true);
  });

  it('source=sample routes are strictly ignored (returns false even with 100% session)', () => {
    expect(computeNeedsSession(100, 0, 'sample')).toBe(false);
    expect(computeNeedsSession(50, 0, 'sample')).toBe(false);
  });
});

describe('computeNeedsSessionFromStats (time-windowed heuristic)', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');

  it('6 months of 100%-session history + last 7 days at 50% → needsSession=false', () => {
    const stats: RouteStatEntry[] = [
      // 6 months ago: 100% session (5,000 requests with session, 0 without)
      {
        hour: new Date('2026-03-12T12:00:00.000Z'),
        withSession: 5000,
        withoutSession: 0,
      },
      // 3 months ago: 100% session (2,000 requests)
      {
        hour: new Date('2026-06-12T12:00:00.000Z'),
        withSession: 2000,
        withoutSession: 0,
      },
      // 2 weeks ago: 100% session (1,000 requests)
      {
        hour: new Date('2026-08-25T12:00:00.000Z'),
        withSession: 1000,
        withoutSession: 0,
      },
      // Last 7 days (e.g. 2 days ago): 50% session (10 withSession, 10 withoutSession = 20 samples >= 3)
      {
        hour: new Date('2026-09-10T12:00:00.000Z'),
        withSession: 10,
        withoutSession: 10,
      },
    ];

    // Evaluated against the recent 7-day window:
    // Only the last 7 days (10 with, 10 without) are considered -> ratio without = 50% > 5% -> false
    const needsSession = computeNeedsSessionFromStats(stats, { now, windowDays: 7 });
    expect(needsSession).toBe(false);

    // Demonstration of the statistical bug if lifetime stats had been aggregated without window:
    // Total withSession = 8010, withoutSession = 10 -> open ratio = 10 / 8020 = 0.12% <= 5% -> true (WRONG)
    expect(computeNeedsSession(8010, 10)).toBe(true);
  });

  it('keeps the min-3-samples rule on the recent window (ignores obsolete history)', () => {
    const stats: RouteStatEntry[] = [
      // 6 months ago: thousands of samples
      {
        hour: new Date('2026-03-12T12:00:00.000Z'),
        withSession: 10000,
        withoutSession: 0,
      },
      // Last 7 days: only 2 samples (less than min-3-samples)
      {
        hour: new Date('2026-09-11T12:00:00.000Z'),
        withSession: 2,
        withoutSession: 0,
      },
    ];

    // In the last 7 days, only 2 samples exist -> cannot guess, must return false
    const needsSession = computeNeedsSessionFromStats(stats, { now, windowDays: 7 });
    expect(needsSession).toBe(false);
  });

  it('promotes newly protected routes: public in the past, but 100% session in last 7 days → needsSession=true', () => {
    const stats: RouteStatEntry[] = [
      // 6 months ago: completely public (10,000 requests without session)
      {
        hour: new Date('2026-03-12T12:00:00.000Z'),
        withSession: 0,
        withoutSession: 10000,
      },
      // Last 7 days: authenticated (50 requests with session, 0 without)
      {
        hour: new Date('2026-09-10T12:00:00.000Z'),
        withSession: 50,
        withoutSession: 0,
      },
    ];

    // Recent window reflects new protected reality
    const needsSession = computeNeedsSessionFromStats(stats, { now, windowDays: 7 });
    expect(needsSession).toBe(true);
  });

  it('source=sample in stats is strictly ignored', () => {
    const stats: RouteStatEntry[] = [
      {
        hour: new Date('2026-09-11T12:00:00.000Z'),
        withSession: 100,
        withoutSession: 0,
      },
    ];

    expect(computeNeedsSessionFromStats(stats, { now, source: 'sample' })).toBe(false);
  });
});