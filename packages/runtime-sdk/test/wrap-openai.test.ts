import { describe, expect, it, vi } from 'vitest';

import { wrapOpenAI, type OpenAIClientLike } from '../src/ai/wrap-openai.ts';
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

describe('wrapOpenAI', () => {
  it('usage capture + metadata-only event', async () => {
    const runtime = fakeRuntime();
    const create = vi.fn().mockResolvedValue({ usage: { prompt_tokens: 100, completion_tokens: 50 } });
    const client = { chat: { completions: { create } } } as unknown as OpenAIClientLike;
    const wrapped = wrapOpenAI(client, { runtime });

    await wrapped.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });

    const ev = runtime.events[0] as AiCallEvent;
    expect(ev.type).toBe('ai_call');
    expect(ev.promptTokens).toBe(100);
    expect(ev.completionTokens).toBe(50);
    expect(ev.costMicroUsd).toBe(45);
    expect(ev).not.toHaveProperty('messages'); // prompt text kabhi nahi
    expect(runtime.flushCount).toBeGreaterThan(0); // ⭐ flush called for serverless
  });

  it('⭐ ceiling cross → provider call HI nahi hua (no money spent)', async () => {
    const runtime = fakeRuntime();
    const create = vi.fn().mockResolvedValue({});
    const client = { chat: { completions: { create } } } as unknown as OpenAIClientLike;
    const fw = new SpendFirewall({ projectId: 'p', store: new MemorySpendStore(), ceilingUsdPerHour: 0.000001 });
    const wrapped = wrapOpenAI(client, { runtime, firewall: fw });

    await expect(
      wrapped.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
    ).rejects.toBeInstanceOf(SpendCeilingError);

    expect(create).not.toHaveBeenCalled(); // ⭐⭐ proof
  });

  it('unknown model bhi firewall me GINA jata hai (fallback patch ka payoff)', async () => {
    const runtime = fakeRuntime();
    const create = vi.fn().mockResolvedValue({});
    const client = { chat: { completions: { create } } } as unknown as OpenAIClientLike;
    const fw = new SpendFirewall({ projectId: 'p', store: new MemorySpendStore(), ceilingUsdPerHour: 0.000001 });
    const wrapped = wrapOpenAI(client, { runtime, firewall: fw });

    await expect(
      wrapped.chat.completions.create({ model: 'mystery-model-v9', messages: [{ role: 'user', content: 'y'.repeat(400) }] }),
    ).rejects.toBeInstanceOf(SpendCeilingError);
    expect(create).not.toHaveBeenCalled();
  });

  it('stream: chunks untouched, usage last chunk se', async () => {
    const runtime = fakeRuntime();
    async function* stream() {
      yield { choices: [{ delta: { content: 'he' } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    }
    const create = vi.fn().mockResolvedValue(stream());
    const client = { chat: { completions: { create } } } as unknown as OpenAIClientLike;
    const wrapped = wrapOpenAI(client, { runtime });

    const out = await wrapped.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const chunks: unknown[] = [];
    for await (const c of out as AsyncIterable<unknown>) chunks.push(c);

    expect(chunks).toHaveLength(2);
    const ev = runtime.events[0] as AiCallEvent;
    expect(ev.completionTokens).toBe(5);
  });

  it('stream break/abandon: finally block reports and refunds properly', async () => {
    const runtime = fakeRuntime();
    const store = new MemorySpendStore();
    const fw = new SpendFirewall({ projectId: 'p1', store, ceilingUsdPerHour: 10 });
    const refundSpy = vi.spyOn(fw, 'refund');

    async function* endlessStream() {
      yield { choices: [{ delta: { content: 'part 1' } }] };
      yield { choices: [{ delta: { content: 'part 2' } }] };
      yield { choices: [{ delta: { content: 'part 3' } }] };
    }
    const create = vi.fn().mockResolvedValue(endlessStream());
    const client = { chat: { completions: { create } } } as unknown as OpenAIClientLike;
    const wrapped = wrapOpenAI(client, { runtime, firewall: fw });

    const out = await wrapped.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'test question' }],
      stream: true,
    });

    // Consume only 1 chunk then break
    for await (const _ of out as AsyncIterable<unknown>) {
      break;
    }

    // Verify report was called even after break
    expect(runtime.events).toHaveLength(1);
    const ev = runtime.events[0] as AiCallEvent;
    expect(ev.type).toBe('ai_call');
    expect(ev.model).toBe('gpt-4o-mini');
    // Verify refund was called because exact cost < reserved cost
    expect(refundSpy).toHaveBeenCalled();
    expect(runtime.flushCount).toBeGreaterThan(0);
  });
});