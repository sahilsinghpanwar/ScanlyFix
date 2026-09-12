import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import { projects, runtimeCanaries, runtimeCanaryEvents } from '../schema.ts';

export type CanaryProjectConfig = {
  projectId: string;
  supabaseUrl: string;
  serviceKey: string; // DECRYPTED — Only in memory, never on the wire.
  anonKey: string | null;
  snapshot: { payloadHashes: Record<string, string>; logRowCount: number; takenAt: string } | null;
};

export type CanaryProjectConfigRaw = {
  projectId: string;
  supabaseUrl: string;
  serviceKeyEnc: string;
  anonKeyEnc: string | null;
  snapshot: CanaryProjectConfig['snapshot'];
};

/** Returns raw encrypted values — caller must decrypt with their encryption layer. */
export async function getCanaryProjectConfigRaw(projectId: string): Promise<CanaryProjectConfigRaw | null> {
  const [row] = await db
    .select({
      id: projects.id,
      supabaseUrl: projects.supabaseUrl,
      serviceKeyEnc: projects.supabaseServiceKeyEnc,
      anonKeyEnc: projects.supabaseAnonKeyEnc,
      snapshot: projects.canarySnapshot,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row?.supabaseUrl || !row.serviceKeyEnc) return null;

  return {
    projectId: row.id,
    supabaseUrl: row.supabaseUrl,
    serviceKeyEnc: row.serviceKeyEnc,
    anonKeyEnc: row.anonKeyEnc ?? null,
    snapshot: row.snapshot ?? null,
  };
}

/** Returns decrypted config. decryptFn provided by caller to avoid cross-package import. */
export async function getCanaryProjectConfig(
  projectId: string,
  decryptFn?: (enc: string) => string,
): Promise<CanaryProjectConfig | null> {
  const raw = await getCanaryProjectConfigRaw(projectId);
  if (!raw) return null;

  // If no decrypt fn provided, return null safely (prevents bad cross-package import)
  if (!decryptFn) return null;

  return {
    projectId: raw.projectId,
    supabaseUrl: raw.supabaseUrl,
    serviceKey: decryptFn(raw.serviceKeyEnc),
    anonKey: raw.anonKeyEnc ? decryptFn(raw.anonKeyEnc) : null,
    snapshot: raw.snapshot,
  };
}

export async function saveSupabaseConnection(projectId: string, url: string, serviceKeyEnc: string, anonKeyEnc: string | null): Promise<void> {
  await db
    .update(projects)
    .set({ supabaseUrl: url, supabaseServiceKeyEnc: serviceKeyEnc, supabaseAnonKeyEnc: anonKeyEnc })
    .where(eq(projects.id, projectId));
}

export async function clearSupabaseConnection(projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({
      supabaseUrl: null, supabaseServiceKeyEnc: null, supabaseAnonKeyEnc: null,
      canariesSetupAt: null, canarySnapshot: null,
    })
    .where(eq(projects.id, projectId));
}

export async function markCanariesSetup(projectId: string, snapshot: CanaryProjectConfig['snapshot']): Promise<void> {
  await db
    .update(projects)
    .set({ canariesSetupAt: new Date(), canarySnapshot: snapshot })
    .where(eq(projects.id, projectId));
  await db
    .update(runtimeCanaries)
    .set({ status: 'planted', plantedAt: new Date() })
    .where(and(eq(runtimeCanaries.projectId, projectId), eq(runtimeCanaries.status, 'pending_script')));
}

export async function listCanaries(projectId: string) {
  return db.select().from(runtimeCanaries).where(eq(runtimeCanaries.projectId, projectId)).orderBy(runtimeCanaries.markerToken);
}

export async function updateCanaryStatus(projectId: string, marker: string, status: string, integrity: string): Promise<void> {
  await db
    .update(runtimeCanaries)
    .set({ status, lastIntegrity: integrity, lastCheckedAt: new Date() })
    .where(and(eq(runtimeCanaries.projectId, projectId), eq(runtimeCanaries.markerToken, marker)));
}

export async function insertCanaryEvents(
  events: Array<{ projectId: string; canaryId: string | null; kind: string; detail: string; source: string }>,
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await db.insert(runtimeCanaryEvents).values(events).returning({ id: runtimeCanaryEvents.id });
  return rows.length;
}

export async function listCanaryEvents(projectId: string, limit = 50) {
  return db
    .select()
    .from(runtimeCanaryEvents)
    .where(eq(runtimeCanaryEvents.projectId, projectId))
    .orderBy(desc(runtimeCanaryEvents.detectedAt))
    .limit(limit);
}

export async function countCanaryEvents(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runtimeCanaryEvents)
    .where(eq(runtimeCanaryEvents.projectId, projectId));
  return row?.n ?? 0;
}

export async function listCanaryEligibleProjectIds(): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(isNotNull(projects.canariesSetupAt), isNotNull(projects.supabaseServiceKeyEnc)));
  return rows.map((r) => r.id);
}

/** Honeytoken lookup — token se canary (route ke liye). */
export async function findCanaryByHoneytoken(token: string) {
  const [row] = await db
    .select({ id: runtimeCanaries.id, projectId: runtimeCanaries.projectId })
    .from(runtimeCanaries)
    .where(and(eq(runtimeCanaries.honeytokenPath, token), eq(runtimeCanaries.status, 'planted')))
    .limit(1);
  return row ?? null;
}