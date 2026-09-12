import { upsertModelPricingCatalog } from '@scanlyfix/db';
import { inngest } from '../../lib/inngest.ts';
import { transformLiteLlmCatalog } from '../../lib/runtime/ai-pricing/server-pricing.ts';

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Weekly sync for LiteLLM pricing catalog.
 * Cron: 'TZ=UTC 0 4 * * 1' (Mondays at 04:00 UTC).
 *
 * Fail-open design: if fetch or transform fails, the previous catalog remains in DB,
 * the error is logged via Inngest logger, and it never throws past retries.
 */
export const runtimePricingSync = inngest.createFunction(
  {
    id: 'runtime/pricing-sync',
    triggers: [{ cron: 'TZ=UTC 0 4 * * 1' }],
    concurrency: { limit: 1 },
    retries: 1,
  },
  async ({ step, logger }) => {
    const syncResult = await step.run('fetch-and-sync-litellm-catalog', async () => {
      try {
        const res = await fetch(LITELLM_PRICING_URL, {
          signal: AbortSignal.timeout(15_000), // 15s timeout
        });

        if (!res.ok) {
          logger.warn('LiteLLM catalog fetch failed with non-200 status', { status: res.status });
          return { ok: false, reason: `HTTP_${res.status}` };
        }

        const rawData = (await res.json()) as Record<string, unknown>;
        const catalog = transformLiteLlmCatalog(rawData);

        if (catalog.length === 0) {
          logger.warn('LiteLLM catalog yielded 0 entries after transform');
          return { ok: false, reason: 'empty_catalog' };
        }

        await upsertModelPricingCatalog(catalog, new Date());
        logger.info('LiteLLM pricing catalog successfully synced', { entryCount: catalog.length });
        return { ok: true, entryCount: catalog.length };
      } catch (err) {
        // Fail-open: fetch/transform failure keeps previous catalog, log error, do not throw past retry
        logger.warn('LiteLLM catalog sync failed; keeping previous catalog', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, reason: 'fetch_or_transform_error' };
      }
    });

    return syncResult;
  },
);
