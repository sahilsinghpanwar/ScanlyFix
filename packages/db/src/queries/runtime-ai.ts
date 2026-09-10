import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import { projects, runtimeAiCalls, runtimeSpendAlerts } from '../schema.ts';

export type IngestAiCallEvent = {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs?: number;
  costMicroUsd: number;
  userHash?: string | null;
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
    .where(and(eq(runtimeAiCalls.projectId, projectId), gte(runtimeAiCalls.createdAt, since)));
  return Number(row?.total ?? 0);
}

/** Live window — velocity watch isi se chalta hai (hourly rollup ka wait nahi). */
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

export async function getSpendBreakdown(projectId: string, sinceMinutes = 24 * 60) {
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  const rawByModel = await db
    .select({
      model: runtimeAiCalls.model,
      calls: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
    })
    .from(runtimeAiCalls)
    .where(and(eq(runtimeAiCalls.projectId, projectId), gte(runtimeAiCalls.createdAt, since)))
    .groupBy(runtimeAiCalls.model)
    .orderBy(desc(sql`sum(${runtimeAiCalls.costMicroUsd})`));

  const rawByUser = await db
    .select({
      userHash: runtimeAiCalls.userHash,
      calls: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
    })
    .from(runtimeAiCalls)
    .where(and(eq(runtimeAiCalls.projectId, projectId), gte(runtimeAiCalls.createdAt, since)))
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

/** Watch list — jinke paas ceiling set hai. */
export async function listSpendWatchProjectIds(): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(sql`${projects.runtimeSpendCeilingMicroUsd} is not null and ${projects.runtimeSpendCeilingMicroUsd} > 0`);
  return rows.map((r) => r.id);
}