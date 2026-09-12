import { createHash } from 'node:crypto';
import {
  getProjectOwnerEmail,
  getRuntimeProjectContext,
  listProberEligibleProjectIds,
} from '@scanlyfix/db';

import { inngest, EVENTS } from '../../lib/inngest.ts';
import { sendEmail } from '../../lib/email.ts';
import { runAuthProber } from '../../lib/runtime/auth-prober/index.ts';
import { buildProberAlertEmail, summarizeRun } from '../../lib/runtime/auth-prober/alert.ts';
import { syncGuardRoutesToProber } from '../../lib/runtime/guard/sync.ts';

/**
 * Calculates a deterministic jitter slot in minutes [0, 60) based on projectId.
 * Formula: (hash(projectId) % 60) minutes so probes spread across 02:00-03:00 UTC.
 */
export function calculateProberJitterMinutes(projectId: string): number {
  const hash = createHash('sha256').update(projectId).digest();
  const num = hash.readUInt32BE(0);
  return num % 60; // strictly in [0, 59]
}

/**
 * Computes the target timestamp for step.sleepUntil given a base time (defaults to now).
 */
export function calculateProberSleepUntil(projectId: string, baseTime: Date = new Date()): Date {
  const jitterMinutes = calculateProberJitterMinutes(projectId);
  return new Date(baseTime.getTime() + jitterMinutes * 60 * 1000);
}

/**
 * Parent nightly auth prober — runs at 02:00 UTC.
 * Lists eligible projects and fans out one 'runtime/auth-prober.run-project' event per project.
 * Finishes in seconds regardless of fleet size.
 */
export const runtimeAuthProber = inngest.createFunction(
  {
    id: 'runtime/auth-prober-nightly',
    triggers: [{ cron: 'TZ=UTC 0 2 * * *' }],
    concurrency: { limit: 1 },
    retries: 2,
  },
  async ({ step, logger }) => {
    const projectIds = await step.run('list-eligible-projects', listProberEligibleProjectIds);
    logger.info('auth-prober: eligible projects', { count: projectIds.length });

    if (projectIds.length === 0) {
      return { eligibleCount: 0, dispatched: 0 };
    }

    await step.sendEvent(
      'fan-out-prober-runs',
      projectIds.map((projectId) => ({
        name: EVENTS.authProberRunProject,
        data: { projectId },
      })),
    );

    return { eligibleCount: projectIds.length, dispatched: projectIds.length };
  },
);

/**
 * Child worker for auth prober — consumes 'runtime/auth-prober.run-project'.
 * Concurrency: keyed by 'event.data.projectId' with limit 1.
 * Jitter: sleeps (hash(projectId) % 60) minutes via step.sleepUntil to spread across 02:00-03:00 UTC.
 */
export const runtimeAuthProberProject = inngest.createFunction(
  {
    id: 'runtime/auth-prober-project',
    triggers: [{ event: EVENTS.authProberRunProject }],
    concurrency: { limit: 1, key: 'event.data.projectId' },
    retries: 2,
  },
  async ({ event, step, logger }) => {
    const { projectId } = event.data as { projectId: string };

    // 1. Jitter sleep: spread across 02:00-03:00 UTC instead of stampeding at 02:00
    const sleepUntil = calculateProberSleepUntil(projectId, new Date());
    await step.sleepUntil('jitter-sleep', sleepUntil);

    // 2. Guard routes sync before probing
    await step.run('sync-guard', async () => {
      try {
        const result = await syncGuardRoutesToProber(projectId);
        if (result.synced > 0) {
          logger.info('auth-prober: guard sync', { projectId, synced: result.synced });
        }
        return result;
      } catch (error) {
        logger.warn('auth-prober: guard sync failed, prober will use existing targets', {
          projectId,
          error,
        });
        return { synced: 0, candidates: 0 };
      }
    });

    // 3. Run auth prober with alert dispatch
    const summary = await step.run('probe-project', async () =>
      runAuthProber(projectId, {
        onNewFindings: async (findings) => {
          const [ownerEmail, projectCtx] = await Promise.all([
            getProjectOwnerEmail(projectId),
            getRuntimeProjectContext(projectId),
          ]);
          if (!ownerEmail) {
            logger.warn('auth-prober: no owner email found', { projectId });
            return;
          }
          const email = buildProberAlertEmail({
            projectUrl: projectCtx?.hostname ?? projectId,
            findings,
          });
          await sendEmail({ to: ownerEmail, ...email });
        },
      }),
    );

    logger.info('auth-prober: run completed', { projectId, summary: summarizeRun(summary) });
    return { projectId, summary };
  },
);
