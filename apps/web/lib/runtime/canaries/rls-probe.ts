import type { CanaryDetection } from './types';

export type AnonProbeResult = { status: number; rowCount: number | null };

/*
* RLS verdict — deterministic:
* 200 + rows > 0 → HOLE (the anonymous user can read the canary, so anyone can) 🚨
* 200 + rows = 0 → RLS is working (the policy filters out all rows)
* 401/403        → RLS is working
* 0 (network)    → Inconclusive — do not trigger an alarm
*/

export function evaluateAnonProbe(result: AnonProbeResult): CanaryDetection | null {
  if (result.status === 200 && result.rowCount !== null && result.rowCount > 0) {
    return {
      kind: 'anon_readable', source: 'rls_probe', canaryId: null,
      detail: 'Anon (public) key se canary table PADHI JA SAKTI hai — RLS policy missing/hole',
    };
  }
  return null; // 200-empty, 401, 403, 0 → sab theek ya inconclusive
}

/** Audit: table names + anon HEAD counts → readable list. only NAAM report , no data. */
export function buildAnonAuditReport(
  tables: ReadonlyArray<{ name: string; anonCount: number | null }>,
  exclude: ReadonlySet<string>,
): { readable: string[]; protectedCount: number; unreachable: number } {
  const readable: string[] = [];
  let protectedCount = 0;
  let unreachable = 0;
  for (const t of tables) {
    if (exclude.has(t.name)) continue;
    if (t.anonCount === null) unreachable++;
    else if (t.anonCount > 0) readable.push(t.name);
    else protectedCount++;
  }
  return { readable, protectedCount, unreachable };
}