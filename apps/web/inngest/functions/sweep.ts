/**
 * The scheduler: one cron, fanning out to one event per due monitor.
 *
 * Fan-out rather than a loop that does the work inline, for two reasons that
 * both bite at scale. A single long function processing five hundred monitors
 * has one retry, one timeout and one failure — so one unreachable site can stall
 * every monitor behind it. And Inngest can only apply concurrency limits, retry
 * policies and observability per function, which means the uptime probe and the
 * full re-scan need to be separate functions to have separate limits at all.
 *
 * The sweep itself does almost nothing, which is the point: it should never be
 * the thing that fails.
 *
 * Race condition prevention:
 *   The sweep uses `claimDueMonitors()` which does an atomic UPDATE RETURNING.
 *   This advances `lastRunAt` for all claimed monitors in a single statement,
 *   preventing double-dispatch when multiple sweep invocations run concurrently.
 *   If a probe fails, the monitor will be retried after its normal interval —
 *   we do NOT reset the lease on probe failure.
 */

import { claimDueMonitors, purgeOldAiCallsBatch, purgeExpiredRuntimeSecrets } from '@scanlyfix/db'
import { inngest, EVENTS } from '@/lib/inngest.ts'

const BATCH_SIZE = 500

/**
 * Pure function: calculates the retention cutoff date.
 * Any records created before this cutoff are older than the retention window (default: 90 days).
 */
export function retentionCutoff(now: Date = new Date(), days = 90): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/**
 * Checks if the daily retention sweep should execute for the current sweep invocation.
 * Scheduled once daily at 03:00 UTC during the minute-level monitor sweep.
 */
export function isDailyRetentionDue(now: Date = new Date()): boolean {
  return now.getUTCHours() === 3 && now.getUTCMinutes() === 0
}

/**
 * Every minute. The minimum useful uptime resolution, and each monitor's own
 * intervalS decides whether it is actually due — so a daily certificate check
 * costs one row in a query, not a run.
 *
 * Uses atomic claim (UPDATE RETURNING) to prevent race conditions between
 * concurrent sweep invocations. Each monitor is claimed by exactly one sweep.
 */
export const sweepMonitors = inngest.createFunction(
  { id: 'monitor-sweep', triggers: [{ cron: '* * * * *' }], concurrency: { limit: 1 } },
  async ({ step }) => {
    let totalDispatched = 0

    // Batch processing: claim and dispatch in chunks of 500
    // This handles 10k+ monitors without memory issues
    for (;;) {
      const claimed = await step.run('claim-batch', () => claimDueMonitors(BATCH_SIZE))
      if (claimed.length === 0) break

      await step.sendEvent(
        'dispatch-batch',
        claimed.map((monitor) => ({
          name: EVENTS.monitorDue,
          data: {
            monitorId: monitor.id,
            type: monitor.type,
            projectId: monitor.projectId,
            url: monitor.projectUrl,
            ownerId: monitor.ownerId,
          },
        })),
      )

      totalDispatched += claimed.length

      // If we got fewer than BATCH_SIZE, we're done
      if (claimed.length < BATCH_SIZE) break
    }

    // Daily retention step: delete runtime_ai_calls older than 90 days
    // and purge expired runtime signing secrets (rotated > 24h ago).
    // Batch size 10,000 in a loop inside purgeOldAiCallsBatch to avoid holding locks
    let aiCallsPurged = 0
    let expiredSecretsPurged = 0
    const now = new Date()
    if (isDailyRetentionDue(now)) {
      aiCallsPurged = await step.run('purge-expired-ai-calls', async () => {
        const cutoff = retentionCutoff(now, 90)
        return purgeOldAiCallsBatch(cutoff, 10_000)
      })

      expiredSecretsPurged = await step.run('purge-expired-runtime-secrets', async () => {
        const graceCutoff = new Date(now.getTime() - 24 * 3600_000)
        return purgeExpiredRuntimeSecrets(graceCutoff)
      })
    }

    return { dispatched: totalDispatched, aiCallsPurged, expiredSecretsPurged }
  },
)
