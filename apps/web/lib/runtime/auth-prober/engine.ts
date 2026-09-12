import {
  autoResolveFinding,
  findUnresolvedFinding,
  getRuntimeProjectContext,
  insertFinding,
  listProberTargets,
  recordCheck,
  seedProberTargets,
  setBaseline,
  touchFinding,
  type NewProberTarget,
} from '@scanlyfix/db';

import { evaluateTarget, isProtectedStatus } from './classify';
import { probeTarget, probeTargetWithAnonKey } from './probe';
import { getOrRefreshProjectAnonKey } from './anon-key';
import { defaultTargetsForSeeding } from './targets';
import {
  MAX_TARGETS_PER_PROJECT,
  PROBE_PARALLELISM,
  type ProberFindingItem,
  type ProberRunSummary,
  type TargetVerdict,
} from './types';

export type EngineHooks = {
  /** Findings jab banein (sirf NAYE) — caller alerts bhejne ka faisla karega. */
  onNewFindings?: (findings: ProberFindingItem[]) => Promise<void>;
};

/**
 * Poora prober run — manual button aur nightly cron DONO yahi call karte hain.
 * Per-target baseline hai, isliye naye targets apni pehli raat sirf record hote hain.
 */
export async function runAuthProber(projectId: string, hooks: EngineHooks = {}): Promise<ProberRunSummary> {
  const summary: ProberRunSummary = {
    projectId,
    ranAt: new Date().toISOString(),
    baselinesRecorded: 0,
    checked: 0,
    newFindings: 0,
    autoResolved: 0,
    stillOpen: 0,
    errors: 0,
  };

  const project = await getRuntimeProjectContext(projectId);
  if (!project?.hostname) return summary; // domain nahi → kuch nahi ho sakta

  // Gates: bina domain verification ke probe = hathiyar ban sakta hai (CheckVibe wala rule).
  if (!project.isVerified) return summary;

  // Supabase anon-key discovery / cache refresh (weekly)
  const anonKeyInfo = await getOrRefreshProjectAnonKey(projectId, project.hostname);

  // Targets: pehli baar defaults seed karo, warna jo hai wahi.
  let targets = await listProberTargets(projectId);
  if (targets.length === 0) {
    await seedProberTargets(projectId, defaultTargetsForSeeding() as NewProberTarget[]);
    targets = await listProberTargets(projectId);
  }
  const bounded = targets.slice(0, MAX_TARGETS_PER_PROJECT);

  // Politeness: chhote chunks me parallel — 5 at a time, 50 targets max.
  const newFindings: ProberFindingItem[] = [];

  for (let i = 0; i < bounded.length; i += PROBE_PARALLELISM) {
    const chunk = bounded.slice(i, i + PROBE_PARALLELISM);
    const results = await Promise.all(
      chunk.map(async (target) => {
        const outcome = await probeTarget(project.hostname, target.path);
        return { target, outcome };
      }),
    );

    for (const { target, outcome } of results) {
      if (!outcome.ok) {
        summary.errors++;
        continue; // app down / timeout — judge mat karo (false alarm ki #1 wajah)
      }

      const verdict: TargetVerdict = evaluateTarget({
        path: target.path,
        baseline: target.baselineStatus,
        actual: outcome.status,
      });

      switch (verdict.verdict) {
        case 'baseline_recorded':
          await setBaseline(target.id, verdict.status);
          summary.baselinesRecorded++;
          break;

        case 'protected': {
          await recordCheck(target.id, verdict.status);
          summary.checked++;
          // Pehle open tha, ab locked → purani plain finding khud resolve ho jaye.
          const openPlain = await findUnresolvedFinding(projectId, target.path, target.method, null);
          if (openPlain) {
            await autoResolveFinding(openPlain.id);
            summary.autoResolved++;
          }

          // Anon-key probe variant: ONLY when bare probe is protected AND an anon key exists
          if (anonKeyInfo && target.baselineStatus !== null && isProtectedStatus(target.baselineStatus)) {
            const anonOutcome = await probeTargetWithAnonKey(project.hostname, target.path, anonKeyInfo.key);
            if (anonOutcome.ok) {
              const anonVerdict = evaluateTarget({
                path: target.path,
                baseline: target.baselineStatus,
                actual: outcome.status,
                anonActual: anonOutcome.status,
              });

              if (anonVerdict.verdict === 'anon_open') {
                const existingAnon = await findUnresolvedFinding(projectId, target.path, target.method, 'anon_role');
                if (existingAnon) {
                  await touchFinding(existingAnon.id); // duplicate alert nahi — same finding zinda hai
                  summary.stillOpen++;
                } else {
                  const created = await insertFinding({
                    projectId,
                    targetId: target.id,
                    path: target.path,
                    method: target.method,
                    baselineStatus: target.baselineStatus,
                    actualStatus: anonVerdict.anonStatus,
                    severity: anonVerdict.severity,
                    variant: 'anon_role',
                    keyFingerprint: anonKeyInfo.fingerprint,
                  });
                  if (created) {
                    newFindings.push({
                      path: created.path,
                      severity: created.severity as any,
                      baselineStatus: created.baselineStatus,
                      actualStatus: created.actualStatus,
                      variant: 'anon_role',
                      keyFingerprint: anonKeyInfo.fingerprint,
                    });
                    summary.newFindings++;
                  }
                }
              } else if (anonVerdict.verdict === 'protected') {
                // Anon probe is also protected → auto-resolve past anon finding if any
                const openAnon = await findUnresolvedFinding(projectId, target.path, target.method, 'anon_role');
                if (openAnon) {
                  await autoResolveFinding(openAnon.id);
                  summary.autoResolved++;
                }
              }
            }
          }
          break;
        }

        case 'open': {
          await recordCheck(target.id, verdict.status);
          summary.checked++;
          if (target.baselineStatus !== null && verdict.status >= 200 && verdict.status < 300) {
            const baselineWasProtected = isProtectedStatus(target.baselineStatus);
            if (baselineWasProtected) {
              const existing = await findUnresolvedFinding(projectId, target.path, target.method, null);
              if (existing) {
                await touchFinding(existing.id); // duplicate alert nahi — same finding zinda hai
                summary.stillOpen++;
              } else {
                const created = await insertFinding({
                  projectId,
                  targetId: target.id,
                  path: target.path,
                  method: target.method,
                  baselineStatus: target.baselineStatus,
                  actualStatus: verdict.status,
                  severity: verdict.severity,
                  variant: null,
                  keyFingerprint: null,
                });
                if (created) {
                  newFindings.push({
                    path: created.path,
                    severity: created.severity as any,
                    baselineStatus: created.baselineStatus,
                    actualStatus: created.actualStatus,
                    variant: null,
                    keyFingerprint: null,
                  });
                  summary.newFindings++;
                }
              }
            }
          }
          break;
        }

        case 'inconclusive':
          await recordCheck(target.id, verdict.status);
          summary.checked++;
          break; // 404/429/5xx — shor nahi
      }
    }
  }

  if (newFindings.length > 0) await hooks.onNewFindings?.(newFindings);
  return summary;
}