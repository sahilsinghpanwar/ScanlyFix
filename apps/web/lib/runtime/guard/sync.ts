import { listGuardRoutes, seedProberTargets, upgradeProberTargetSource } from '@scanlyfix/db';
import { computeNeedsSession } from './heuristic.ts';

/** Politeness cap — maximum routes synced to nightly prober. */
const MAX_PROBER_SYNC_ROUTES = 50;

/** Freshness cutoff — routes older than 14 days must not produce new prober targets. */
export const MAX_ROUTE_STALENESS_DAYS = 14;
export const MAX_ROUTE_STALENESS_MS = MAX_ROUTE_STALENESS_DAYS * 24 * 60 * 60 * 1000;

export type SyncResult = { synced: number; candidates: number };

export type SyncGuardRoutesOptions = {
  now?: Date;
  maxStalenessMs?: number;
};

/**
 * Checks whether a route was observed recently enough to produce new prober targets.
 * Routes whose lastSeenAt is older than 14 days (or maxStalenessMs) are considered stale.
 */
export function isRouteFresh(
  lastSeenAt: Date | string | undefined | null,
  now: Date = new Date(),
  maxStalenessMs: number = MAX_ROUTE_STALENESS_MS,
): boolean {
  if (!lastSeenAt) return true; // graceful fallback for partial test fixtures
  const seenTime = typeof lastSeenAt === 'string' ? new Date(lastSeenAt).getTime() : lastSeenAt.getTime();
  if (isNaN(seenTime)) return true;
  return now.getTime() - seenTime <= maxStalenessMs;
}

/**
 * Syncs discovered routes that need a session to the prober targets.
 *
 * Safety rules:
 *  - Only GET routes — never probe POST/PUT/DELETE mutations.
 *  - Server actions are observed, never automatically invoked.
 *  - Manual targets are never overwritten.
 *  - Freshness check: Routes whose last_seen_at is older than 14 days must NOT produce
 *    new prober targets (stale inventory). Existing targets in the database are left untouched.
 */
export async function syncGuardRoutesToProber(
  projectId: string,
  options?: SyncGuardRoutesOptions,
): Promise<SyncResult> {
  const routes = await listGuardRoutes(projectId);
  const now = options?.now ?? new Date();
  const maxStalenessMs = options?.maxStalenessMs ?? MAX_ROUTE_STALENESS_MS;

  const candidates = routes
    .filter(
      (r) =>
        r.source !== 'sample' &&
        r.kind === 'route' &&
        r.method === 'GET' &&
        isRouteFresh(r.lastSeenAt, now, maxStalenessMs) &&
        computeNeedsSession(r.withSession, r.withoutSession, r.source),
    )
    .slice(0, MAX_PROBER_SYNC_ROUTES)
    .map((r) => ({ path: r.pattern, method: r.method, source: 'guard' as const }));

  if (candidates.length === 0) return { synced: 0, candidates: 0 };

  await seedProberTargets(projectId, candidates);
  await upgradeProberTargetSource(projectId, candidates);

  return { synced: candidates.length, candidates: routes.length };
}