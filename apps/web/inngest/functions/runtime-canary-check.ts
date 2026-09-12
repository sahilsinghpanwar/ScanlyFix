import {
  getProjectOwnerEmail,
  getRuntimeProjectContext,
  listCanaryEligibleProjectIds,
} from '@scanlyfix/db';

import { inngest } from '../../lib/inngest.ts';
import { sendEmail } from '../../lib/email.ts';
import { buildCanaryAlertEmail } from '../../lib/runtime/canaries/alert.ts';
import { runCanaryCheck } from '../../lib/runtime/canaries/index.ts';

/**
 * Nightly canary check — 02:30 UTC (prober 02:00 se door, load spread).
 * Detections critical hote hain — email turant, dedupe ki zaroorat nahi
 * (detection = asli occurrence, repeat event = repeat information).
 */
export const runtimeCanaryCheck = inngest.createFunction(
  { id: 'runtime/canary-nightly', triggers: [{ cron: 'TZ=UTC 30 2 * * *' }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step, logger }) => {
    const projectIds = await step.run('list-eligible', listCanaryEligibleProjectIds);
    logger.info('canary: eligible projects', { count: projectIds.length });

    for (const projectId of projectIds) {
      await step.run(`check:${projectId}`, async () => {
        const summary = await runCanaryCheck(projectId);

        if (summary.detections.length > 0) {
          const [ownerEmail, ctx] = await Promise.all([
            getProjectOwnerEmail(projectId),
            getRuntimeProjectContext(projectId),
          ]);
          if (ownerEmail) {
            const email = buildCanaryAlertEmail({
              hostname: ctx?.hostname ?? projectId,
              detections: summary.detections,
            });
            await sendEmail({ to: ownerEmail, ...email });
          }
        }
        return {
          reachable: summary.reachable,
          detections: summary.detections.length,
          integrity: summary.integrity,
        };
      });
    }
    return { checked: projectIds.length };
  },
);