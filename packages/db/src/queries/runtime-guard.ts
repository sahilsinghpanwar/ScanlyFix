import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import { runtimeProberTargets, runtimeRouteStats, runtimeRoutes } from '../schema.ts';

/** Raw aggregated row — aggregated counts for dashboard display and heuristic evaluation. */
export type GuardRouteRow = {
  id: string;
  pattern: string;
  method: string;
  kind: string;
  source: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  withSession: number;
  withoutSession: number;
};

export type GuardRoutesWindow =
  | string
  | number
  | { days?: number; hours?: number; since?: Date }
  | null;

export type ListGuardRoutesOptions = {
  limit?: number;
  window?: GuardRoutesWindow;
  now?: Date;
};

/**
 * Parses a window specification into a cutoff Date.
 * Supported formats:
 * - '7d', '7 days', '24h', '24 hours', '30d'
 * - number (treated as days, e.g. 7)
 * - object { days, hours, since }
 * - null / 'all' (disables windowing, returns null)
 * Default: 7 days ago.
 */
export function parseGuardWindowCutoff(
  window: GuardRoutesWindow = '7d',
  now: Date = new Date(),
): Date | null {
  if (window === null || window === 'all') return null;

  if (typeof window === 'object') {
    if (window.since instanceof Date) {
      return window.since;
    }
    const days = window.days ?? (window.hours ? window.hours / 24 : 7);
    return new Date(now.getTime() - days * 24 * 3600_000);
  }

  if (typeof window === 'number') {
    return new Date(now.getTime() - window * 24 * 3600_000);
  }

  if (typeof window === 'string') {
    const trimmed = window.trim().toLowerCase();
    const match = trimmed.match(/^(\d+)\s*(d|day|days|h|hour|hours|m|min|mins|minutes)?$/);
    if (match && match[1]) {
      const val = parseInt(match[1], 10);
      const unit = match[2] ?? 'd';
      if (unit.startsWith('h')) {
        return new Date(now.getTime() - val * 3600_000);
      }
      if (unit.startsWith('m')) {
        return new Date(now.getTime() - val * 60_000);
      }
      return new Date(now.getTime() - val * 24 * 3600_000);
    }
  }

  return new Date(now.getTime() - 7 * 24 * 3600_000);
}

/**
 * Lists routes and aggregates their session counts within a recent time window.
 * Default window is '7d' (last 7 days of runtime_route_stats).
 */
export async function listGuardRoutes(
  projectId: string,
  limitOrOptions: number | ListGuardRoutesOptions = 200,
  windowParam: GuardRoutesWindow = '7d',
): Promise<GuardRouteRow[]> {
  let limit = 200;
  let window: GuardRoutesWindow = '7d';
  let now = new Date();

  if (typeof limitOrOptions === 'number') {
    limit = limitOrOptions;
    window = windowParam;
  } else if (typeof limitOrOptions === 'object' && limitOrOptions !== null) {
    if (limitOrOptions.limit !== undefined) limit = limitOrOptions.limit;
    if (limitOrOptions.window !== undefined) window = limitOrOptions.window;
    if (limitOrOptions.now !== undefined) now = limitOrOptions.now;
  }

  const cutoff = parseGuardWindowCutoff(window, now);
  const joinCondition = cutoff
    ? and(
        eq(runtimeRouteStats.routeId, runtimeRoutes.id),
        gte(runtimeRouteStats.hour, cutoff),
      )
    : eq(runtimeRouteStats.routeId, runtimeRoutes.id);

  return db
    .select({
      id: runtimeRoutes.id,
      pattern: runtimeRoutes.pattern,
      method: runtimeRoutes.method,
      kind: runtimeRoutes.kind,
      source: runtimeRoutes.source,
      firstSeenAt: runtimeRoutes.firstSeenAt,
      lastSeenAt: runtimeRoutes.lastSeenAt,
      withSession: sql<number>`coalesce(sum(${runtimeRouteStats.withSession}), 0)::int`,
      withoutSession: sql<number>`coalesce(sum(${runtimeRouteStats.withoutSession}), 0)::int`,
    })
    .from(runtimeRoutes)
    .leftJoin(runtimeRouteStats, joinCondition)
    .where(eq(runtimeRoutes.projectId, projectId))
    .groupBy(runtimeRoutes.id)
    .orderBy(desc(runtimeRoutes.lastSeenAt))
    .limit(limit);
}

export type ClearRoutesResult = {
  deletedRoutes: number;
  deletedTargets: number;
};

/**
 * Clears all observed routes for a project AND removes synced 'guard' prober targets
 * in a single transaction. Preserves 'manual' and 'default' targets.
 */
export async function clearGuardRoutes(projectId: string): Promise<ClearRoutesResult> {
  return db.transaction(async (tx) => {
    const deletedRoutes = await tx
      .delete(runtimeRoutes)
      .where(eq(runtimeRoutes.projectId, projectId))
      .returning({ id: runtimeRoutes.id });

    const deletedTargets = await tx
      .delete(runtimeProberTargets)
      .where(
        and(
          eq(runtimeProberTargets.projectId, projectId),
          eq(runtimeProberTargets.source, 'guard'),
        ),
      )
      .returning({ id: runtimeProberTargets.id });

    return {
      deletedRoutes: deletedRoutes.length,
      deletedTargets: deletedTargets.length,
    };
  });
}

export type IngestRouteEvent = {
  pattern: string;
  method: string;
  kind?: string;
  hasSession: boolean;
};

/**
 * Records a batch of route events — bulk approach: collapses 2N sequential
 * DB round-trips (old per-event loop) into 3 queries total regardless of
 * batch size.
 *
 * Steps:
 *   1. Bulk-upsert all route patterns in ONE INSERT … ON CONFLICT statement.
 *   2. Pre-aggregate session/no-session counts per routeId in memory.
 *   3. Bulk-upsert the resulting stats rows in ONE INSERT … ON CONFLICT.
 */
export async function recordRouteEvents(
  projectId: string,
  events: IngestRouteEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  // Filter out malformed events up front.
  const valid = events.filter((e) => e.pattern && e.method);
  if (valid.length === 0) return 0;

  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  const now = new Date();

  // ── Step 1: Bulk-upsert all route patterns in ONE statement ──────────────
  // On conflict we only update lastSeenAt. We do NOT overwrite `kind` because
  // a route seen as 'server_action' must not be demoted to 'route' by a
  // subsequent event on the same pattern.
  const routeValues = valid.map((e) => ({
    projectId,
    pattern: e.pattern,
    method: e.method.toUpperCase(),
    kind: e.kind ?? 'route',
    source: null,
  }));

  const upsertedRoutes = await db
    .insert(runtimeRoutes)
    .values(routeValues)
    .onConflictDoUpdate({
      target: [runtimeRoutes.projectId, runtimeRoutes.pattern, runtimeRoutes.method],
      set: {
        lastSeenAt: now,
        source: sql`null`,
      },
    })
    .returning({ id: runtimeRoutes.id, pattern: runtimeRoutes.pattern, method: runtimeRoutes.method });

  // Build a lookup: "PATTERN::METHOD" → routeId
  const routeIdMap = new Map<string, string>();
  for (const r of upsertedRoutes) {
    routeIdMap.set(`${r.pattern}::${r.method}`, r.id);
  }

  // ── Step 2: Pre-aggregate counts per routeId in memory ───────────────────
  // If the same pattern appears multiple times in the batch, their counts are
  // summed here so the DB increment is a single add, not N separate updates.
  const statAgg = new Map<string, { routeId: string; withSession: number; withoutSession: number }>();
  for (const e of valid) {
    const key = `${e.pattern}::${e.method.toUpperCase()}`;
    const routeId = routeIdMap.get(key);
    if (!routeId) continue;
    const existing = statAgg.get(routeId) ?? { routeId, withSession: 0, withoutSession: 0 };
    if (e.hasSession) {
      existing.withSession += 1;
    } else {
      existing.withoutSession += 1;
    }
    statAgg.set(routeId, existing);
  }

  // ── Step 3: Bulk-upsert hourly stats in ONE statement ────────────────────
  // `excluded` refers to the values that conflicted — Postgres adds them to
  // the existing counters atomically.
  const statValues = Array.from(statAgg.values()).map((s) => ({
    routeId: s.routeId,
    hour,
    withSession: s.withSession,
    withoutSession: s.withoutSession,
  }));

  if (statValues.length > 0) {
    await db
      .insert(runtimeRouteStats)
      .values(statValues)
      .onConflictDoUpdate({
        target: [runtimeRouteStats.routeId, runtimeRouteStats.hour],
        set: {
          withSession: sql`${runtimeRouteStats.withSession} + excluded.with_session`,
          withoutSession: sql`${runtimeRouteStats.withoutSession} + excluded.without_session`,
        },
      });
  }

  return statAgg.size;
}

/** Seeds sample traffic events for dev testing and demonstration. */
export async function seedDemoGuardRoutes(projectId: string): Promise<void> {
  const demoRoutes: Array<{ pattern: string; method: string; kind: 'route' | 'server_action'; withSession: number; withoutSession: number }> = [
    { pattern: '/dashboard', method: 'GET', kind: 'route', withSession: 54, withoutSession: 1 },
    { pattern: '/dashboard/settings', method: 'GET', kind: 'route', withSession: 38, withoutSession: 0 },
    { pattern: '/settings/billing', method: 'GET', kind: 'route', withSession: 29, withoutSession: 0 },
    { pattern: '/api/projects', method: 'GET', kind: 'route', withSession: 42, withoutSession: 0 },
    { pattern: '/api/scans', method: 'POST', kind: 'server_action', withSession: 26, withoutSession: 0 },
    { pattern: '/api/user', method: 'GET', kind: 'route', withSession: 65, withoutSession: 0 },
    { pattern: '/pricing', method: 'GET', kind: 'route', withSession: 4, withoutSession: 88 },
    { pattern: '/about', method: 'GET', kind: 'route', withSession: 2, withoutSession: 110 },
  ];

  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);

  for (const item of demoRoutes) {
    const [route] = await db
      .insert(runtimeRoutes)
      .values({
        projectId,
        pattern: item.pattern,
        method: item.method,
        kind: item.kind,
        source: 'sample',
      })
      .onConflictDoUpdate({
        target: [runtimeRoutes.projectId, runtimeRoutes.pattern, runtimeRoutes.method],
        set: { lastSeenAt: new Date() },
      })
      .returning({ id: runtimeRoutes.id });

    if (!route) continue;

    await db
      .insert(runtimeRouteStats)
      .values({
        routeId: route.id,
        hour,
        withSession: item.withSession,
        withoutSession: item.withoutSession,
      })
      .onConflictDoUpdate({
        target: [runtimeRouteStats.routeId, runtimeRouteStats.hour],
        set: {
          withSession: sql`${runtimeRouteStats.withSession} + ${item.withSession}`,
          withoutSession: sql`${runtimeRouteStats.withoutSession} + ${item.withoutSession}`,
        },
      });
  }
}