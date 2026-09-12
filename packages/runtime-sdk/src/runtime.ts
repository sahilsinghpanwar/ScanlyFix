import type { RouteEvent } from './guard/observe.ts';

export type AiCallEvent = {
  type: 'ai_call';
  provider: 'openai' | 'anthropic' | string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costMicroUsd: number;
  userHash?: string;
};

export type RuntimeEvent = RouteEvent | AiCallEvent;

export interface RuntimeConfig {
  /** Project UUID. If omitted, ScanlyFix automatically identifies the project from x-runtime-host */
  projectId?: string;
  /** Optional fallback host domain for auto-detection */
  host?: string;
  signingSecret?: string;
  ingestUrl: string;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  onError?: (err: unknown) => void;
}

export interface RuntimeClient {
  config: RuntimeConfig;
  report: (event: RuntimeEvent) => void;
  flush: (requestHost?: string) => Promise<void>;
}

export function createRuntime(config: RuntimeConfig): RuntimeClient {
  const queue: RuntimeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<void> | null = null;

  function flush(requestHost?: string): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (activeFlush) {
      return activeFlush.then(() => {
        if (queue.length > 0) {
          return flush(requestHost);
        }
      });
    }

    const effectiveHost = requestHost ?? config.host;
    if (queue.length === 0 || !config.ingestUrl || (!config.projectId && !effectiveHost)) {
      return Promise.resolve();
    }

    activeFlush = (async () => {
      try {
        while (queue.length > 0) {
          const batch = queue.splice(0, config.maxBatchSize ?? 50);
          if (batch.length === 0) break;

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);

          try {
            const headers: Record<string, string> = {
              'content-type': 'application/json',
            };
            if (config.projectId) {
              headers['x-runtime-project-id'] = config.projectId;
            }
            if (effectiveHost) {
              headers['x-runtime-host'] = effectiveHost;
            }
            if (config.signingSecret) {
              headers['x-runtime-signature'] = config.signingSecret;
            }

            await fetch(config.ingestUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify({ events: batch }),
              signal: controller.signal,
              keepalive: true,
            });
          } catch (err) {
            config.onError?.(err);
          } finally {
            clearTimeout(timer);
          }
        }
      } finally {
        activeFlush = null;
      }
    })();

    return activeFlush;
  }

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, config.flushIntervalMs ?? 5_000);
  }

  return {
    config,
    report(event: RuntimeEvent) {
      queue.push(event);
      if (queue.length >= (config.maxBatchSize ?? 10)) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
  };
}
