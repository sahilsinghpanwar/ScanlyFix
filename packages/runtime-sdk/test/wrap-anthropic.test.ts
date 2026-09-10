import { describe, expect, it, vi } from 'vitest';

import { wrapAnthropic, type AnthropicClientLike } from '../src/ai/wrap-anthropic.ts';
import { MemorySpendStore, SpendCeilingError, SpendFirewall } from '../src/ai/spend-firewall.ts';
import type { AiCallEvent, RuntimeClient, RuntimeEvent } from '../src/runtime.ts';

function fakeRuntime(): RuntimeClient & { events: RuntimeEvent[]; flushCount: number } {
  const events: RuntimeEvent[] = [];
  const state = { flushCount: 0 };
  return {
    events,
    get flushCount() { return state.flushCount; },
    report: (e: RuntimeEvent) => { events.push(e); },
    flush: async () => { state.flushCount++; },
    config: { projectId: 'p', signingSecret: 's', ingestUrl: 'http://test' },
  };
}

describe('wrapAnthropic', () => {
  it('captures usage and reports metadata-only event', async () => {
    const runtime = fakeRuntime();
    const create = vi.fn().mockResolvedValue({
      model: 'claude-3-5-sonnet',
      usage: { input_tokens: 150, output_tokens: 80 },
    });
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const wrapped = wrapAnthropic(client, { runtime });

    await wrapped.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'hello claude' }],
    });

    expect(runtime.events).toHaveLength(1);
    const ev = runtime.events[0] as AiCallEvent;
    expect(ev.type).toBe('ai_call');
    expect(ev.provider).toBe('anthropic');
    expect(ev.model).toBe('claude-3-5-sonnet');
    expect(ev.promptTokens).toBe(150);
    expect(ev.completionTokens).toBe(80);
    expect(ev.costMicroUsd).toBeGreaterThan(0);
    expect(ev).not.toHaveProperty('messages');
    expect(runtime.flushCount).toBeGreaterThan(0);
  });

  it('blocks call before provider when ceiling is crossed', async () => {
    const runtime = fakeRuntime();
    const create = vi.fn().mockResolvedValue({});
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const fw = new SpendFirewall({ projectId: 'p', store: new MemorySpendStore(), ceilingUsdPerHour: 0.000001 });
    const wrapped = wrapAnthropic(client, { runtime, firewall: fw });

    await expect(
      wrapped.messages.create({
        model: 'claude-3-opus',
        max_tokens: 4000,
        messages: [{ role: 'user', content: 'test message' }],
      }),
    ).rejects.toBeInstanceOf(SpendCeilingError);

    expect(create).not.toHaveBeenCalled();
  });

  it('instruments stream and collects tokens from events', async () => {
    const runtime = fakeRuntime();
    async function* stream() {
      yield { type: 'message_start', message: { usage: { input_tokens: 50 } } };
      yield { type: 'content_block_delta', delta: { text: 'Hello' } };
      yield { type: 'message_delta', usage: { output_tokens: 25 } };
    }
    const create = vi.fn().mockResolvedValue(stream());
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const wrapped = wrapAnthropic(client, { runtime });

    const out = await wrapped.messages.create({
      model: 'claude-3-5-haiku',
      max_tokens: 500,
      messages: [{ role: 'user', content: 'stream hi' }],
      stream: true,
    });

    const chunks: unknown[] = [];
    for await (const c of out as AsyncIterable<unknown>) chunks.push(c);

    expect(chunks).toHaveLength(3);
    expect(runtime.events).toHaveLength(1);
    const ev = runtime.events[0] as AiCallEvent;
    expect(ev.provider).toBe('anthropic');
    expect(ev.promptTokens).toBe(50);
    expect(ev.completionTokens).toBe(25);
  });

  it('stream break/abandon: finally block reports and refunds properly', async () => {
    const runtime = fakeRuntime();
    const store = new MemorySpendStore();
    const fw = new SpendFirewall({ projectId: 'p1', store, ceilingUsdPerHour: 10 });
    const refundSpy = vi.spyOn(fw, 'refund');

    async function* endlessStream() {
      yield { type: 'message_start', message: { usage: { input_tokens: 60 } } };
      yield { type: 'content_block_delta', delta: { text: 'chunk 1' } };
      yield { type: 'message_delta', usage: { output_tokens: 10 } };
      yield { type: 'content_block_delta', delta: { text: 'chunk 2' } };
      yield { type: 'message_delta', usage: { output_tokens: 20 } };
    }
    const create = vi.fn().mockResolvedValue(endlessStream());
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const wrapped = wrapAnthropic(client, { runtime, firewall: fw });

    const out = await wrapped.messages.create({
      model: 'claude-3-5-haiku',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'test stream break' }],
      stream: true,
    });

    for await (const _ of out as AsyncIterable<unknown>) {
      break;
    }

    expect(runtime.events).toHaveLength(1);
    const ev = runtime.events[0] as AiCallEvent;
    expect(ev.provider).toBe('anthropic');
    expect(refundSpy).toHaveBeenCalled();
    expect(runtime.flushCount).toBeGreaterThan(0);
  });
});
