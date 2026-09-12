import { and, desc, eq, gte, isNull, ne, or, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import {
  projects,
  runtimeAiCalls,
  runtimeModelPricing,
  runtimeSpendAlerts,
  type CatalogEntry,
} from '../schema.ts';

export type IngestAiCallEvent = {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs?: number;
  costMicroUsd: number;
  userHash?: string | null;
  source?: string | null;
};

export async function recordAiCallEvents(
  projectId: string,
  events: IngestAiCallEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const rows = events.map((ev) => ({
    projectId,
    provider: ev.provider,
    model: ev.model,
    promptTokens: Math.max(0, Math.round(Number(ev.promptTokens) || 0)),
    completionTokens: Math.max(0, Math.round(Number(ev.completionTokens) || 0)),
    latencyMs: Math.max(0, Math.round(Number(ev.latencyMs) || 0)),
    costMicroUsd: Math.max(0, Math.round(Number(ev.costMicroUsd) || 0)),
    userHash: ev.userHash ?? null,
    source: ev.source ?? null,
  }));

  const inserted = await db.insert(runtimeAiCalls).values(rows).returning({ id: runtimeAiCalls.id });
  return inserted.length;
}

export async function listRecentAiCalls(projectId: string, limit = 100) {
  return db
    .select()
    .from(runtimeAiCalls)
    .where(eq(runtimeAiCalls.projectId, projectId))
    .orderBy(desc(runtimeAiCalls.createdAt))
    .limit(limit);
}

export const getRecentAiCalls = listRecentAiCalls;

async function sumSpendSince(projectId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint` })
    .from(runtimeAiCalls)
    .where(
      and(
        eq(runtimeAiCalls.projectId, projectId),
        gte(runtimeAiCalls.createdAt, since),
        or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Live window — velocity watch isi se chalta hai (hourly rollup ka wait nahi). Excludes sample calls. */
export function getSpendWindowMicroUsd(projectId: string, minutes: number): Promise<number> {
  return sumSpendSince(projectId, new Date(Date.now() - minutes * 60_000));
}

export function getCurrentHourSpendMicroUsd(projectId: string): Promise<number> {
  const h = new Date();
  h.setUTCMinutes(0, 0, 0);
  return sumSpendSince(projectId, h);
}

export function getSpendLast24hMicroUsd(projectId: string): Promise<number> {
  return sumSpendSince(projectId, new Date(Date.now() - 24 * 60 * 60_000));
}

export type HourlySpendBucket = {
  hour: string;
  timestamp: number;
  costMicroUsd: number;
  calls: number;
};

/**
 * Returns continuous hourly buckets over the last N hours (default 24).
 * Always returns exactly N buckets in chronological order, filling empty hours with 0.
 * Excludes source='sample' test calls.
 */
export async function getSpendHourlyBuckets(
  projectId: string,
  hours = 24,
  now: Date = new Date(),
): Promise<HourlySpendBucket[]> {
  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);

  const startHour = new Date(currentHour.getTime() - (hours - 1) * 3600_000);

  const rows = await db
    .select({
      bucketHour: sql<string>`date_trunc('hour', ${runtimeAiCalls.createdAt})`,
      calls: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
    })
    .from(runtimeAiCalls)
    .where(
      and(
        eq(runtimeAiCalls.projectId, projectId),
        gte(runtimeAiCalls.createdAt, startHour),
        or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
      ),
    )
    .groupBy(sql`date_trunc('hour', ${runtimeAiCalls.createdAt})`);

  const map = new Map<number, { costMicroUsd: number; calls: number }>();
  for (const r of rows) {
    const ts = new Date(r.bucketHour).getTime();
    map.set(ts, {
      costMicroUsd: Number(r.costMicroUsd),
      calls: Number(r.calls),
    });
  }

  const buckets: HourlySpendBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const h = new Date(currentHour.getTime() - i * 3600_000);
    const ts = h.getTime();
    const existing = map.get(ts);
    buckets.push({
      hour: h.toISOString(),
      timestamp: ts,
      costMicroUsd: existing?.costMicroUsd ?? 0,
      calls: existing?.calls ?? 0,
    });
  }

  return buckets;
}

export async function getSpendBreakdown(projectId: string, sinceMinutes = 24 * 60) {
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  const filterClause = and(
    eq(runtimeAiCalls.projectId, projectId),
    gte(runtimeAiCalls.createdAt, since),
    or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
  );

  const rawByModel = await db
    .select({
      model: runtimeAiCalls.model,
      calls: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
    })
    .from(runtimeAiCalls)
    .where(filterClause)
    .groupBy(runtimeAiCalls.model)
    .orderBy(desc(sql`sum(${runtimeAiCalls.costMicroUsd})`));

  const rawByUser = await db
    .select({
      userHash: runtimeAiCalls.userHash,
      calls: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
    })
    .from(runtimeAiCalls)
    .where(filterClause)
    .groupBy(runtimeAiCalls.userHash)
    .orderBy(desc(sql`sum(${runtimeAiCalls.costMicroUsd})`))
    .limit(5);

  const byModel = rawByModel.map((m) => ({
    model: m.model,
    calls: Number(m.calls),
    costMicroUsd: Number(m.costMicroUsd),
  }));

  const byUser = rawByUser.map((u) => ({
    userHash: u.userHash,
    calls: Number(u.calls),
    costMicroUsd: Number(u.costMicroUsd),
  }));

  return { byModel, byUser };
}

export async function getSpendCeilingMicroUsd(projectId: string): Promise<number | null> {
  const [row] = await db
    .select({ c: projects.runtimeSpendCeilingMicroUsd })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.c != null ? Number(row.c) : null;
}

export async function setSpendCeiling(projectId: string, ceilingMicroUsd: number | null): Promise<void> {
  const value = ceilingMicroUsd !== null ? Math.max(0, Math.round(ceilingMicroUsd)) : null;
  await db.update(projects).set({ runtimeSpendCeilingMicroUsd: value }).where(eq(projects.id, projectId));
}

/** Insert-or-nothing — row mili = pehla alert is hour; nahi mili = dedupe. Race-safe. */
export async function claimSpendAlertHour(
  projectId: string,
  hour: Date,
  spentMicroUsd: number,
  projectedMicroUsd: number,
) {
  const [row] = await db
    .insert(runtimeSpendAlerts)
    .values({
      projectId,
      hour,
      spentMicroUsd: Math.max(0, Math.round(spentMicroUsd)),
      projectedMicroUsd: Math.max(0, Math.round(projectedMicroUsd)),
    })
    .onConflictDoNothing()
    .returning({ id: runtimeSpendAlerts.id });
  return row ?? null;
}

/** Watch list — projects to monitor for velocity alerts (custom ceiling OR default $10/h guard). */
export async function listSpendWatchProjectIds(): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(sql`1 = 1`);
  return rows.map((r) => r.id);
}

/**
 * Deletes runtime_ai_calls older than cutoff in batches of batchSize (default 10,000)
 * in a loop to avoid holding long database table locks.
 */
export async function purgeOldAiCallsBatch(
  cutoff: Date,
  batchSize = 10_000,
): Promise<number> {
  let totalDeleted = 0;
  for (;;) {
    const deleted = await db.execute<{ id: string }>(sql`
      DELETE FROM ${runtimeAiCalls}
      WHERE id IN (
        SELECT id FROM ${runtimeAiCalls}
        WHERE ${runtimeAiCalls.createdAt} < ${cutoff}
        LIMIT ${batchSize}
      )
      RETURNING id
    `);

    const count =
      (deleted as { rowCount?: number })?.rowCount ??
      (Array.isArray(deleted)
        ? deleted.length
        : Array.isArray((deleted as { rows?: unknown[] })?.rows)
          ? (deleted as { rows: unknown[] }).rows.length
          : 0);
    totalDeleted += count;
    if (count < batchSize) break;
  }
  return totalDeleted;
}

/**
 * Fetches the cached LiteLLM pricing catalog from PostgreSQL.
 * Returns array of CatalogEntry or null if not yet synced.
 */
export async function getModelPricingCatalog(): Promise<CatalogEntry[] | null> {
  const [row] = await db
    .select({ catalog: runtimeModelPricing.catalog })
    .from(runtimeModelPricing)
    .where(eq(runtimeModelPricing.id, 'litellm'))
    .limit(1);
  return (row?.catalog as CatalogEntry[]) ?? null;
}

/**
 * Upserts the LiteLLM pricing catalog row (id: 'litellm').
 */
export async function upsertModelPricingCatalog(
  catalog: CatalogEntry[],
  fetchedAt: Date = new Date(),
): Promise<void> {
  await db
    .insert(runtimeModelPricing)
    .values({
      id: 'litellm',
      catalog,
      entryCount: catalog.length,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: runtimeModelPricing.id,
      set: {
        catalog,
        entryCount: catalog.length,
        fetchedAt,
      },
    });
}