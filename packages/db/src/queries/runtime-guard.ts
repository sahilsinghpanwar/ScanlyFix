import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import { runtimeRouteStats, runtimeRoutes } from '../schema.ts';

/** Raw aggregated row — aggregated counts for dashboard display and heuristic evaluation. */
export type GuardRouteRow = {
  id: string;
  pattern: string;
  method: string;
  kind: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  withSession: number;
  withoutSession: number;
};

export async function listGuardRoutes(projectId: string, limit = 200): Promise<GuardRouteRow[]> {
  return db
    .select({
      id: runtimeRoutes.id,
      pattern: runtimeRoutes.pattern,
      method: runtimeRoutes.method,
      kind: runtimeRoutes.kind,
      firstSeenAt: runtimeRoutes.firstSeenAt,
      lastSeenAt: runtimeRoutes.lastSeenAt,
      withSession: sql<number>`coalesce(sum(${runtimeRouteStats.withSession}), 0)::int`,
      withoutSession: sql<number>`coalesce(sum(${runtimeRouteStats.withoutSession}), 0)::int`,
    })
    .from(runtimeRoutes)
    .leftJoin(runtimeRouteStats, eq(runtimeRouteStats.routeId, runtimeRoutes.id))
    .where(eq(runtimeRoutes.projectId, projectId))
    .groupBy(runtimeRoutes.id)
    .orderBy(desc(runtimeRoutes.lastSeenAt))
    .limit(limit);
}

export async function clearGuardRoutes(projectId: string): Promise<number> {
  const deleted = await db
    .delete(runtimeRoutes)
    .where(eq(runtimeRoutes.projectId, projectId))
    .returning({ id: runtimeRoutes.id });
  return deleted.length;
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
  }));

  const upsertedRoutes = await db
    .insert(runtimeRoutes)
    .values(routeValues)
    .onConflictDoUpdate({
      target: [runtimeRoutes.projectId, runtimeRoutes.pattern, runtimeRoutes.method],
      set: { lastSeenAt: now },
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