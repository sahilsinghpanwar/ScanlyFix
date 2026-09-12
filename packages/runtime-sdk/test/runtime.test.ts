import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, type RuntimeEvent } from '../src/runtime.ts';

describe('createRuntime and flush()', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('drains all events in batches during flush()', async () => {
    const sentBatches: RuntimeEvent[][] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      sentBatches.push(body.events);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const runtime = createRuntime({
      projectId: 'proj-xyz',
      ingestUrl: 'https://example.com/api/runtime/ingest',
      maxBatchSize: 10,
    });

    // Enqueue 25 events
    for (let i = 0; i < 25; i++) {
      runtime.report({
        type: 'ai_call',
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 100,
        costMicroUsd: 10,
      });
    }

    await runtime.flush();

    const totalEvents = sentBatches.reduce((acc, b) => acc + b.length, 0);
    expect(totalEvents).toBe(25);
    expect(sentBatches.length).toBeGreaterThanOrEqual(3); // 10 + 10 + 5
  });

  it('passes x-runtime-signature only when signingSecret is configured', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const rt1 = createRuntime({
      projectId: 'p1',
      ingestUrl: 'https://example.com/api',
      signingSecret: 'sec-123',
    });

    rt1.report({
      type: 'ai_call',
      provider: 'openai',
      model: 'gpt-4o',
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costMicroUsd: 1,
    });

    await rt1.flush();
    expect(capturedHeaders['x-runtime-signature']).toBe('sec-123');

    // Without secret:
    const rt2 = createRuntime({
      projectId: 'p2',
      ingestUrl: 'https://example.com/api',
    });

    rt2.report({
      type: 'ai_call',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costMicroUsd: 1,
    });

    await rt2.flush();
    expect(capturedHeaders['x-runtime-signature']).toBeUndefined();
  });

  it('calls onError callback on network errors without throwing', async () => {
    const onError = vi.fn();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection reset'));

    const runtime = createRuntime({
      projectId: 'p3',
      ingestUrl: 'https://example.com/api',
      onError,
    });

    runtime.report({
      type: 'ai_call',
      provider: 'openai',
      model: 'gpt-4o',
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costMicroUsd: 1,
    });

    await expect(runtime.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
