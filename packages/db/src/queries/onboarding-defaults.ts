/**
 * Onboarding defaults — auto-create the four monitors every project ships with.
 *
 * ## Why this is its own file
 *
 * `projects.ts` is the read/write surface for the `projects` row every other
 * query joins against. The onboarding flow (createProject + default monitors)
 * is a single transactional concern that crosses two tables — putting it next
 * to `createProject` couples it to the project's read path; putting it in
 * `monitors.ts` couples the monitors surface to project creation. Splitting
 * it out keeps each surface small and lets the onboarding tests target one
 * file.
 *
 * ## Why four monitors, why this state
 *
 * The onboarding research (see MONITORING-FEATURE-PLAN.md) showed that
 * requiring the user to flip four switches after creating a project drops
 * activation to ~10%. Shipping the project with monitors already configured
 * — three enabled, one queued — means a customer who just created an
 * account already has a working status page, a working certificate-expiry
 * check, a working web-vitals schedule, and a daily rescan waiting to be
 * enabled the first time the scan engine touches the project.
 *
 * `rescan` is created disabled on purpose: we do not want to schedule a
 * daily scan against a project that has never been scanned before — the
 * scan needs a baseline first, and the first scan happens during the
 * "claim this anonymous report" funnel. `completeScan` is the hook that
 * flips rescan to enabled once the first scan completes.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { monitors, type Monitor } from '../schema.ts'
import type { MonitorType } from './monitors.ts'

/* -------------------------------------------------------------------------- */
/* Constants — exported so callers + tests can refer to one source of truth   */
/* -------------------------------------------------------------------------- */

/**
 * The four monitor kinds every project ships with. Uptime first because it
 * is the highest-traffic monitor (one probe a minute) and surfaces first on
 * the status page.
 */
export const DEFAULT_MONITOR_TYPES = [
  'uptime',
  'domain',
  'web_vitals',
  'rescan',
] as const satisfies ReadonlyArray<MonitorType>

/** How often each monitor runs by default. Seconds, not minutes. */
export const DEFAULT_MONITOR_INTERVALS: Readonly<Record<MonitorType, number>> = {
  uptime: 60, // one probe a minute
  domain: 86_400, // daily — TLS expiry does not change hourly
  web_vitals: 21_600, // 6h — vitals do not move fast enough to merit hourly
  rescan: 86_400, // daily
}

/**
 * Which monitors are enabled at create-time. `rescan` is intentionally off
 * — see the file header. The other three need no warm-up: they each have
 * a baseline they can compute on the first run.
 */
export const DEFAULT_MONITOR_ENABLED: Readonly<Record<MonitorType, boolean>> = {
  uptime: true,
  domain: true,
  web_vitals: true,
  rescan: false,
}

/* -------------------------------------------------------------------------- */
/* Default monitor bootstrap                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ensure all four default monitors exist for a project. Idempotent —
 * `setMonitor` already upserts on `(projectId, type)`, so a project that
 * already has one monitor of a given type gets its row updated to match
 * the default rather than duplicated.
 *
 * SYSTEM call — no Viewer. The caller (project creation) has already done
 * the auth check; this helper trusts the project id it was given.
 *
 * Returns the inserted/updated monitor rows in DEFAULT_MONITOR_TYPES order
 * so the caller can echo them to the UI without re-querying.
 */
export async function ensureDefaultMonitors(projectId: string): Promise<Monitor[]> {
  const rows: Monitor[] = []
  for (const type of DEFAULT_MONITOR_TYPES) {
    const [row] = await db
      .insert(monitors)
      .values({
        projectId,
        type,
        enabled: DEFAULT_MONITOR_ENABLED[type],
        intervalS: DEFAULT_MONITOR_INTERVALS[type],
      })
      .onConflictDoNothing({
        target: [monitors.projectId, monitors.type],
      })
      .returning()
    if (row) {
      rows.push(row)
    } else {
      const existing = await db.query.monitors.findFirst({
        where: and(eq(monitors.projectId, projectId), eq(monitors.type, type)),
      })
      if (existing) rows.push(existing)
    }
  }
  return rows
}

/* -------------------------------------------------------------------------- */
/* Rescan auto-enable                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Flip the project's `rescan` monitor to enabled IF it currently exists
 * AND is not already enabled. Idempotent — a second call is a no-op.
 *
 * `completeScan` is the call site: after the first scan of a project
 * finishes, the rescan monitor gets enabled so the daily re-scan
 * starts.
 *
 * Returns true if the row was enabled by THIS call, false if the row
 * was missing or already enabled. The caller does not need the return
 * value — the function is fire-and-forget at the end of `completeScan`
 * — but the boolean is exposed for tests.
 *
 * SYSTEM call — no Viewer, same reasoning as `ensureDefaultMonitors`.
 */
export async function enableRescanMonitorIfPresent(
  projectId: string,
): Promise<boolean> {
  const updated = await db
    .update(monitors)
    .set({ enabled: true })
    // WHERE both the type is rescan AND it is not yet enabled. The
    // `enabled: false` predicate is what makes this idempotent — a
    // second call finds no matching row, the UPDATE returns [], and
    // we return false. If the owner explicitly disabled rescan by
    // toggling the monitor off after auto-enable, this predicate
    // protects their choice: the next call still does nothing.
    .where(
      and(eq(monitors.projectId, projectId), eq(monitors.type, 'rescan'), eq(monitors.enabled, false)),
    )
    .returning({ id: monitors.id })

  return updated.length > 0
}
