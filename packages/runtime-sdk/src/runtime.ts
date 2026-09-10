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
  projectId: string;
  signingSecret?: string;
  ingestUrl: string;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  onError?: (err: unknown) => void;
}

export interface RuntimeClient {
  config: RuntimeConfig;
  report: (event: RuntimeEvent) => void;
  flush: () => Promise<void>;
}

export function createRuntime(config: RuntimeConfig): RuntimeClient {
  const queue: RuntimeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<void> | null = null;

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (activeFlush) {
      return activeFlush.then(() => {
        if (queue.length > 0) {
          return flush();
        }
      });
    }

    if (queue.length === 0 || !config.ingestUrl) {
      return Promise.resolve();
    }

    activeFlush = (async () => {
      try {
        while (queue.length > 0) {
          const batch = queue.splice(0, config.maxBatchSize ?? 50);
          if (batch.length === 0) break;

          try {
            const headers: Record<string, string> = {
              'content-type': 'application/json',
              'x-runtime-project-id': config.projectId,
            };
            if (config.signingSecret) {
              headers['x-runtime-signature'] = config.signingSecret;
            }

            await fetch(config.ingestUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify({ events: batch }),
            });
          } catch (err) {
            config.onError?.(err);
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
