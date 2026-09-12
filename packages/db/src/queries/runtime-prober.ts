import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';

import { db } from '../client.ts';
import { projects, runtimeProberFindings, runtimeProberTargets, users } from '../schema.ts';

// ── ADAPT (sirf is function me): apne schema ke actual column names use karo.
//    Tumhare paas migration 0004_domain_verification already hai —
//    'verifiedAt' ko apne verified-flag column se replace karo.
export type RuntimeProjectContext = {
  id: string;
  /** Host only, e.g. "app.example.com" — scheme nahi, path nahi. */
  hostname: string;
  isVerified: boolean;
  anonKeyEncrypted?: string | null;
  anonKeyFingerprint?: string | null;
  anonKeyCheckedAt?: Date | null;
};

export async function getRuntimeProjectContext(projectId: string): Promise<RuntimeProjectContext | null> {
  const [row] = await db
    .select({
      id: projects.id,
      url: projects.url,        // ADAPT: project ka domain column
      verifiedAt: projects.verifiedAt, // ADAPT: verification column
      anonKeyEncrypted: projects.anonKeyEncrypted,
      anonKeyFingerprint: projects.anonKeyFingerprint,
      anonKeyCheckedAt: projects.anonKeyCheckedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row?.url) return null;
  const isDev = process.env.NODE_ENV !== 'production';
  return {
    id: row.id,
    hostname: safeHostname(row.url),
    isVerified: row.verifiedAt !== null || isDev,
    anonKeyEncrypted: row.anonKeyEncrypted,
    anonKeyFingerprint: row.anonKeyFingerprint,
    anonKeyCheckedAt: row.anonKeyCheckedAt,
  };
}

export async function getProjectAnonKey(projectId: string): Promise<{
  anonKeyEncrypted: string | null;
  anonKeyFingerprint: string | null;
  anonKeyCheckedAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      anonKeyEncrypted: projects.anonKeyEncrypted,
      anonKeyFingerprint: projects.anonKeyFingerprint,
      anonKeyCheckedAt: projects.anonKeyCheckedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

export async function updateProjectAnonKey(
  projectId: string,
  data: {
    anonKeyEncrypted: string | null;
    anonKeyFingerprint: string | null;
    anonKeyCheckedAt: Date;
  },
): Promise<void> {
  await db
    .update(projects)
    .set({
      anonKeyEncrypted: data.anonKeyEncrypted,
      anonKeyFingerprint: data.anonKeyFingerprint,
      anonKeyCheckedAt: data.anonKeyCheckedAt,
    })
    .where(eq(projects.id, projectId));
}

function safeHostname(raw: string): string {
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(candidate);
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      return parsed.host; // includes port if present, e.g. localhost:3000
    }
    return parsed.hostname;
  } catch {
    return '';
  }
}

// ── Targets ──────────────────────────────────────────────────

export type NewProberTarget = { path: string; method: string; source: 'default' | 'guard' | 'manual' };

export async function listProberTargets(projectId: string) {
  return db
    .select()
    .from(runtimeProberTargets)
    .where(eq(runtimeProberTargets.projectId, projectId))
    .orderBy(runtimeProberTargets.path);
}

export async function getProberTarget(
  projectId: string,
  path: string,
  method: string = 'GET',
) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const [row] = await db
    .select()
    .from(runtimeProberTargets)
    .where(
      and(
        eq(runtimeProberTargets.projectId, projectId),
        eq(runtimeProberTargets.path, normalizedPath),
        eq(runtimeProberTargets.method, method.toUpperCase()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function countManualProberTargets(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runtimeProberTargets)
    .where(
      and(
        eq(runtimeProberTargets.projectId, projectId),
        eq(runtimeProberTargets.source, 'manual'),
      ),
    );
  return row?.n ?? 0;
}

export async function addProberTarget(
  projectId: string,
  path: string,
  method: string = 'GET',
  source: 'default' | 'guard' | 'manual' = 'manual',
) {
  const upperMethod = method.toUpperCase();
  if (upperMethod !== 'GET') {
    throw new Error(`Only GET method is supported for prober targets (received ${upperMethod})`);
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const [row] = await db
    .insert(runtimeProberTargets)
    .values({
      projectId,
      path: normalizedPath,
      method: upperMethod,
      source,
    })
    .onConflictDoUpdate({
      target: [runtimeProberTargets.projectId, runtimeProberTargets.path, runtimeProberTargets.method],
      set: { source },
    })
    .returning();
  return row ?? null;
}

export async function deleteProberTarget(projectId: string, targetId: string): Promise<boolean> {
  const deleted = await db
    .delete(runtimeProberTargets)
    .where(and(eq(runtimeProberTargets.projectId, projectId), eq(runtimeProberTargets.id, targetId)))
    .returning({ id: runtimeProberTargets.id });
  return deleted.length > 0;
}

export async function seedProberTargets(projectId: string, targets: NewProberTarget[]): Promise<void> {
  const getTargets = targets.filter((t) => (t.method || 'GET').toUpperCase() === 'GET');
  if (getTargets.length === 0) return;
  await db
    .insert(runtimeProberTargets)
    .values(getTargets.map((t) => ({ projectId, ...t, method: 'GET' })))
    .onConflictDoNothing(); // re-run safe — duplicate seed kuch nahi bigadega
}

export async function setBaseline(targetId: string, status: number): Promise<void> {
  await db
    .update(runtimeProberTargets)
    .set({ baselineStatus: status, baselineAt: new Date(), lastCheckedAt: new Date(), lastActualStatus: status })
    .where(eq(runtimeProberTargets.id, targetId));
}

export async function recordCheck(targetId: string, status: number): Promise<void> {
  await db
    .update(runtimeProberTargets)
    .set({ lastCheckedAt: new Date(), lastActualStatus: status })
    .where(eq(runtimeProberTargets.id, targetId));
}

// ── Findings ─────────────────────────────────────────────────

export async function findUnresolvedFinding(
  projectId: string,
  path: string,
  method: string,
  variant?: 'anon_role' | null,
) {
  const variantCondition =
    variant === 'anon_role'
      ? eq(runtimeProberFindings.variant, 'anon_role')
      : isNull(runtimeProberFindings.variant);

  const [row] = await db
    .select()
    .from(runtimeProberFindings)
    .where(
      and(
        eq(runtimeProberFindings.projectId, projectId),
        eq(runtimeProberFindings.path, path),
        eq(runtimeProberFindings.method, method),
        isNull(runtimeProberFindings.resolvedAt),
        variantCondition,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertFinding(input: {
  projectId: string;
  targetId: string;
  path: string;
  method: string;
  baselineStatus: number;
  actualStatus: number;
  severity: 'critical' | 'high';
  variant?: 'anon_role' | null;
  keyFingerprint?: string | null;
}) {
  const [row] = await db.insert(runtimeProberFindings).values(input).returning();
  return row;
}

export async function touchFinding(findingId: string): Promise<void> {
  await db
    .update(runtimeProberFindings)
    .set({ updatedAt: new Date() })
    .where(eq(runtimeProberFindings.id, findingId));
}

/** Darwaza wapas lock ho gaya? Finding khud-ba-khud resolve. */
export async function autoResolveFinding(findingId: string): Promise<void> {
  await db
    .update(runtimeProberFindings)
    .set({ resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(runtimeProberFindings.id, findingId), isNull(runtimeProberFindings.resolvedAt)));
}

export async function resolveFindingManually(findingId: string, projectId: string): Promise<void> {
  await db
    .update(runtimeProberFindings)
    .set({ resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(runtimeProberFindings.id, findingId), eq(runtimeProberFindings.projectId, projectId)));
}

export async function listFindings(projectId: string, onlyOpen: boolean) {
  const where = onlyOpen
    ? and(eq(runtimeProberFindings.projectId, projectId), isNull(runtimeProberFindings.resolvedAt))
    : eq(runtimeProberFindings.projectId, projectId);
  return db.select().from(runtimeProberFindings).where(where).orderBy(desc(runtimeProberFindings.createdAt)).limit(100);
}

export async function countOpenFindings(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runtimeProberFindings)
    .where(and(eq(runtimeProberFindings.projectId, projectId), isNull(runtimeProberFindings.resolvedAt)));
  return row?.n ?? 0;
}

// ── Nightly eligibility: jinke paas baseline hai, sirf unko probe karo ──

export async function listProberEligibleProjectIds(): Promise<string[]> {
  const isDev = process.env.NODE_ENV !== 'production';
  const condition = isDev
    ? isNotNull(runtimeProberTargets.baselineStatus)
    : and(isNotNull(runtimeProberTargets.baselineStatus), isNotNull(projects.verifiedAt));

  const rows = await db
    .selectDistinct({ id: runtimeProberTargets.projectId })
    .from(runtimeProberTargets)
    .innerJoin(projects, eq(projects.id, runtimeProberTargets.projectId))
    .where(condition);
  return rows.map((r) => r.id);
}

// ── Owner email for alerts ──────────────────────────────────────

export async function getProjectOwnerEmail(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.ownerId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.email ?? null;
}



// guard

/**
 * source upgrade: 'default' (guess) → 'guard' (real data).
 * 'manual' user-ki-choice hai — kabhi overwrite nahi hota.
 *
 * Uses a single bulk UPDATE with an inline VALUES list instead of N individual
 * UPDATE statements — regardless of how many routes are synced, this is always
 * ONE DB round-trip.
 */
export async function upgradeProberTargetSource(
  projectId: string,
  targets: ReadonlyArray<{ path: string; method: string }>,
): Promise<void> {
  if (targets.length === 0) return;

  // Build a VALUES list: (path1, method1), (path2, method2), …
  // Drizzle doesn't have a first-class "WHERE (a, b) IN (VALUES …)" API, so
  // we use a raw sql tag. The values are interpolated via Drizzle's sql
  // template, which parameterises them safely — no string concatenation.
  const pairs = targets.map((t) => sql`(${t.path}, ${t.method})`);
  const valuesList = sql.join(pairs, sql`, `);

  await db
    .update(runtimeProberTargets)
    .set({ source: 'guard' })
    .where(
      and(
        eq(runtimeProberTargets.projectId, projectId),
        eq(runtimeProberTargets.source, 'default'), // never overwrite 'manual'
        sql`(${runtimeProberTargets.path}, ${runtimeProberTargets.method}) IN (${valuesList})`,
      ),
    );
}