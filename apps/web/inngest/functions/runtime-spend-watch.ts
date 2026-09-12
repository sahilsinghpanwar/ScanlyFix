import {
  claimSpendAlertHour,
  getProjectOwnerEmail,
  getRuntimeProjectContext,
  getSpendCeilingMicroUsd,
  getSpendWindowMicroUsd,
  listSpendWatchProjectIds,
} from '@scanlyfix/db'; // ⭐ ADAPT

import { inngest } from '../../lib/inngest.ts';
import { sendEmail } from '../../lib/email.ts';
import { evaluateVelocity, DEFAULT_ABSOLUTE_THRESHOLD_USD } from '../../lib/runtime/ai-spend/velocity.ts';
import { formatUsd } from '../../lib/runtime/ai-log/summary.ts';

/**
 * VELOCITY WATCH — har 5 min. 15-min LIVE window se projection.
 * Idempotent: claimSpendAlertHour ka unique(project, hour) = ek hour, ek email.
 */
export const runtimeSpendWatch = inngest.createFunction(
  { id: 'runtime/spend-watch', triggers: [{ cron: 'TZ=UTC */5 * * * *' }], concurrency: { limit: 1 }, retries: 1 },
  async ({ step, logger }) => {
    const projectIds = await step.run('list-watch-projects', listSpendWatchProjectIds);
    logger.info('spend-watch: watching projects', { count: projectIds.length });

    for (const projectId of projectIds) {
      await step.run(`watch:${projectId}`, async () => {
        const [windowMicro, ceilingMicro, ctx] = await Promise.all([
          getSpendWindowMicroUsd(projectId, 15),
          getSpendCeilingMicroUsd(projectId),
          getRuntimeProjectContext(projectId),
        ]);

        const v = evaluateVelocity({ windowMicroUsd: windowMicro, windowMinutes: 15, ceilingMicroUsd: ceilingMicro });
        if (!v.shouldAlert) return 'ok';

        const hourDate = new Date();
        hourDate.setUTCMinutes(0, 0, 0);

        const claimed = await claimSpendAlertHour(
          projectId,
          hourDate,
          windowMicro,
          v.projectedHourlyMicroUsd,
        );
        if (!claimed) return 'already-alerted-this-hour';

        const ownerEmail = await getProjectOwnerEmail(projectId);
        if (!ownerEmail) return 'no-email';

        const thresholdDisplay = ceilingMicro
          ? `${formatUsd(ceilingMicro)}/hour`
          : `$${DEFAULT_ABSOLUTE_THRESHOLD_USD}/hour (default threshold)`;

        const pctDisplay =
          v.pctOfCeiling !== null
            ? ` (${v.pctOfCeiling}% of ceiling)`
            : ` (exceeding default $${DEFAULT_ABSOLUTE_THRESHOLD_USD}/h threshold)`;

        await sendEmail({
          to: ownerEmail,
          subject: `💸 AI spend velocity — ${ctx?.hostname ?? projectId}: projected ${formatUsd(v.projectedHourlyMicroUsd)}/h${pctDisplay}`,
          text: [
            `Pichhle 15 min: ${formatUsd(windowMicro)}`,
            `Is rate par: ${formatUsd(v.projectedHourlyMicroUsd)}/hour`,
            `Alert threshold: ${thresholdDisplay}`,
            '',
            'Runtime → AI spend kholo — "Top user share" batayega loop kis user par chal raha hai.',
            'Hard block chahiye? Apne app me SpendFirewall lagao (ceilingUsdPerHour env) — wo call provider tak jaane se PEHLE refuse karta hai.',
          ].join('\n'),
        });
        logger.info('spend-watch: alert sent', { projectId, pct: v.pctOfCeiling });
        return 'alerted';
      });
    }
    return { watched: projectIds.length };
  },
);