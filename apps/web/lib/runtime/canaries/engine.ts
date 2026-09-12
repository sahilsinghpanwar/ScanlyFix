import {
  insertCanaryEvents,
  listCanaries,
  markCanariesSetup,
  updateCanaryStatus,
  type CanaryProjectConfig,
} from '@scanlyfix/db';
import { decryptValue } from '@/lib/header-encryption';
import { getCanaryProjectConfig } from '@scanlyfix/db';

import { evaluateIntegrity } from './integrity';
import { buildAnonAuditReport, evaluateAnonProbe, type AnonProbeResult } from './rls-probe';
import { listTableNames, restSelect, type RestConfig } from './supabase-rest';
import { CANARY_LOG_TABLE, CANARY_TABLE, MAX_AUDIT_TABLES, type CanaryDetection } from './types';

export type CanaryRunSummary = {
  projectId: string;
  ranAt: string;
  reachable: boolean;
  detections: CanaryDetection[];
  integrity: Record<string, string>;
  newSnapshot: CanaryProjectConfig['snapshot'];
};

/** Ek poora canary check — nightly cron aur "Run check" button dono yahi call karte hain. */
export async function runCanaryCheck(projectId: string): Promise<CanaryRunSummary> {
  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  const summary: CanaryRunSummary = {
    projectId, ranAt: new Date().toISOString(), reachable: false,
    detections: [], integrity: {}, newSnapshot: null,
  };
  if (!cfg) return summary;

  const rest: RestConfig = { url: cfg.supabaseUrl, serviceKey: cfg.serviceKey, anonKey: cfg.anonKey };

  // 1) Integrity — canary rows + trigger log
  const rowsRes = await restSelect<{ marker: string; payload: unknown }>(rest, CANARY_TABLE, { query: 'select=marker,payload' });
  const logRes = await restSelect<{ id: number }>(rest, CANARY_LOG_TABLE, { query: 'select=id', withCount: true });

  if (!rowsRes.ok && rowsRes.status === 404) {
    // Vault table hi nahi — user ne script revert/remove ki ya galat project connect hua
    summary.detections.push({
      kind: 'table_missing', source: 'integrity', canaryId: null,
      detail: `${CANARY_TABLE} table Supabase me nahi mili — setup hata gaya ya connection galat hai`,
    });
  } else if (!rowsRes.ok && rowsRes.status === 0) {
    // Unreachable — alarm nahi (app/server down ≠ breach)
  } else {
    summary.reachable = true;
    const result = evaluateIntegrity({
      snapshot: cfg.snapshot,
      liveRows: rowsRes.data,
      liveLogCount: logRes.count,
    });
    summary.integrity = result.verdicts;
    summary.newSnapshot = result.newSnapshot;

    // Marker verdicts ko canary rows se link karke statuses update karo
    const canaries = await listCanaries(projectId);
    for (const c of canaries) {
      const v = result.verdicts[c.markerToken];
      if (v === 'missing') await updateCanaryStatus(projectId, c.markerToken, 'compromised', v);
      else if (v === 'modified') await updateCanaryStatus(projectId, c.markerToken, 'compromised', v);
      else if (v === 'ok') await updateCanaryStatus(projectId, c.markerToken, 'planted', v);
      // v undefined (table missing) → kuch nahi
      if (v === 'missing' || v === 'modified') {
        const match = result.detections.find((d) => d.detail.startsWith(c.markerToken));
        if (match) match.canaryId = c.id;
      }
    }
    summary.detections.push(...result.detections);
  }

  // 2) RLS probe — anon key se vault padhne ki KOSHISH (deterministic read-check)
  if (cfg.anonKey) {
    const probe: AnonProbeResult = await restSelect<unknown>(rest, CANARY_TABLE, { key: 'anon', limit: 1 }).then((r) => ({
      status: r.status,
      rowCount: r.data?.length ?? (r.status === 200 ? 0 : null),
    }));
    const detection = evaluateAnonProbe(probe);
    if (detection) summary.detections.push(detection);
  }

  // 3) Persist events (dedupe-free — har detection asli occurrence hai; honeytoken apni route se aata hai)
  if (summary.detections.length > 0) {
    await insertCanaryEvents(
      summary.detections.map((d) => ({
        projectId, canaryId: d.canaryId, kind: d.kind, detail: d.detail, source: d.source,
      })),
    );
  } else if (summary.reachable && summary.newSnapshot) {
    // Snapshot mirror refresh (tamper-evidence baseline fresh rahe)
    await markCanariesSetup(projectId, summary.newSnapshot);
  }

  return summary;
}

/**
 * Anon-Access Audit: perform an anonymous read test (count-only) across all tables.
 * "2 of your 12 tables are publicly readable" — proactively identify RLS holes.
 * On-demand (button) — no nightly load. Only table NAMES are reported; no data is ever returned.
 */
export async function runAnonAccessAudit(projectId: string): Promise<{
  readable: string[];
  protectedCount: number;
  unreachable: number;
} | null> {
  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  if (!cfg?.anonKey) return null;
  const rest: RestConfig = { url: cfg.supabaseUrl, serviceKey: cfg.serviceKey, anonKey: cfg.anonKey };

  const tables = await listTableNames(rest);
  if (!tables) return null;

  const EXCLUDE = new Set([CANARY_TABLE, CANARY_LOG_TABLE]);
  const scoped = tables.filter((t) => !EXCLUDE.has(t)).slice(0, MAX_AUDIT_TABLES);

  const results = await Promise.all(
    scoped.map(async (name) => {
      // HEAD + Prefer: count=exact → sirf COUNT aata hai, koi data transfer nahi
      const res = await restSelect<unknown>(rest, name, { key: 'anon', limit: 1, withCount: true });
      return { name, anonCount: res.status === 200 ? (res.count ?? 0) : null };
    }),
  );

  return buildAnonAuditReport(results, EXCLUDE);
}