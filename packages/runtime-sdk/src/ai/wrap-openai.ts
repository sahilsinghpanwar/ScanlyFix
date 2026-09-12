import type { RuntimeClient } from '../runtime.ts';
import { hashUserId } from './hash.ts';
import { estimateCostMicroUsd } from './pricing.ts';
import { estimateProjectedCost, estimatePromptTokens } from './estimate.ts';
import type { SpendFirewall } from './spend-firewall.ts';

/** Structural typing — `openai` package ki hard dependency NAHI. */
export interface OpenAIClientLike {
  chat: { completions: { create: (args: Record<string, unknown>) => Promise<unknown> } };
}

export type AiGuardOptions = {
  /** Guard wala hi runtime — "one more import", same batcher, same ingest. */
  runtime: RuntimeClient;
  firewall?: SpendFirewall;
  /** End-user attribution — yahan id DO, hash hum karenge. Raw id kabhi wire par nahi. */
  getUserId?: () => string | undefined;
};

type Usage = { prompt_tokens?: number; completion_tokens?: number };

type CallArgs = {
  model: string;
  messages: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
  stream_options?: Record<string, unknown>;
  max_tokens?: number;
  max_completion_tokens?: number;
};

function makeEvent(params: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  userIdHash: string | null;
}) {
  const { model, promptTokens, completionTokens, latencyMs, userIdHash } = params;
  return {
    type: 'ai_call' as const,
    provider: 'openai' as const,
    model,
    promptTokens,
    completionTokens,
    latencyMs,
    // Server ingest par RECOMPUTE karega — client cost trust nahi (same pricing module dono taraf)
    costMicroUsd: estimateCostMicroUsd(model, promptTokens, completionTokens),
    userHash: userIdHash ?? undefined,
  };
}

/**
 * Aapke client ka wrapper — proxy NAHI.
 * Key aapki process me, request seedha provider ko, humein sirf metadata.
 */
export function wrapOpenAI<T extends OpenAIClientLike>(client: T, opts: AiGuardOptions): T {
  // wrap karne se pehle, original ko capture karo aur assignment ko cast karo:
  const original = client.chat.completions.create.bind(client.chat.completions) as
    (args: Record<string, unknown>) => Promise<unknown>;

  (client.chat.completions as { create: typeof original }).create = async (rawArgs: Record<string, unknown>) => {
    const args = rawArgs as CallArgs;
    const userId = opts.getUserId?.();
    const userIdHash = userId ? await hashUserId(userId) : null;

    // 1) PRE-CALL: projected cost reserve → ceiling cross? THROW (provider ko call hi nahi)
    const projected = estimateProjectedCost({
      model: args.model,
      messages: args.messages,
      maxOutputTokens: args.max_completion_tokens ?? args.max_tokens,
    });
    await opts.firewall?.check(projected);

    const start = Date.now();
    try {
      // 2) STREAM: official include_usage — last chunk me usage. Chunks USER ko
      //    untouched milte hain; hum sirf padhte hain (watch-only, Guard ki tarah).
      if (args.stream) {
        const enhanced = { ...args, stream_options: { ...(args.stream_options ?? {}), include_usage: true } };
        const stream = (await original(enhanced as Record<string, unknown>)) as AsyncIterable<unknown>;
        return instrumentStream(stream, {
          model: args.model,
          fallbackPromptTokens: estimatePromptTokens(args.messages),
          latencyRef: start,
          userIdHash,
          opts,
          reservedMicroUsd: projected,
        });
      }

      // 3) NON-STREAM: exact usage
      const res = (await original(rawArgs)) as { usage?: Usage; model?: string };
      const promptTokens = res.usage?.prompt_tokens ?? estimatePromptTokens(args.messages);
      const completionTokens = res.usage?.completion_tokens ?? 0;
      opts.runtime.report(
        makeEvent({
          model: res.model ?? args.model,
          promptTokens,
          completionTokens,
          latencyMs: Date.now() - start,
          userIdHash,
        }),
      );
      void opts.runtime.flush();
      // Exact cost < reserved? Extra reservation refund.
      const exact = estimateCostMicroUsd(args.model, promptTokens, completionTokens);
      if (exact < projected) await opts.firewall?.refund(projected - exact);
      return res;
    } catch (e) {
      await opts.firewall?.refund(projected); // provider error → ceiling lock-out nahi
      throw e;
    }
  };

  return client;
}

async function* instrumentStream(
  stream: AsyncIterable<unknown>,
  ctx: {
    model: string;
    fallbackPromptTokens: number;
    latencyRef: number;
    userIdHash: string | null;
    opts: AiGuardOptions;
    reservedMicroUsd: number;
  },
): AsyncGenerator<unknown> {
  let latencyMs = 0;
  let usage: Usage | undefined;
  try {
    for await (const chunk of stream) {
      if (latencyMs === 0) latencyMs = Date.now() - ctx.latencyRef; // time-to-first-chunk
      const u = (chunk as { usage?: Usage }).usage;
      if (u) usage = u;
      yield chunk; // ⭐ chunk MEIN kuch nahi badla
    }
  } finally {
    // ⭐ abandon ho ya complete — report + refund HAMESHA honge
    const promptTokens = usage?.prompt_tokens ?? ctx.fallbackPromptTokens;
    const completionTokens = usage?.completion_tokens ?? 0;
    ctx.opts.runtime.report(
      makeEvent({
        model: ctx.model,
        promptTokens,
        completionTokens,
        latencyMs: latencyMs || Date.now() - ctx.latencyRef,
        userIdHash: ctx.userIdHash,
      }),
    );
    void ctx.opts.runtime.flush();
    const exact = estimateCostMicroUsd(ctx.model, promptTokens, completionTokens);
    if (exact < ctx.reservedMicroUsd) await ctx.opts.firewall?.refund(ctx.reservedMicroUsd - exact);
  }
}