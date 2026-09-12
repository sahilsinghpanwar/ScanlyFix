/**
 * Jab usage na mile (kuch stream modes/purane endpoints) ya ceiling check
 * call se PEHLE karna ho. "~4 chars/token" industry heuristic.
 */
import { findPricing } from './pricing.ts';

export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

type MessageLike = { role?: string; content?: unknown };

/** String YA parts-array content dono handle karta hai, system prompt bhi. */
export function estimatePromptTokens(messages?: ReadonlyArray<MessageLike> | null, system?: unknown): number {
  let chars = 0;
  if (typeof system === 'string') {
    chars += system.length;
  } else if (Array.isArray(system)) {
    for (const part of system) {
      if (typeof part === 'string') chars += part.length;
      else if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') chars += text.length;
      }
    }
  }
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.content === 'string') {
        chars += m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === 'string') chars += part.length;
          else if (part && typeof part === 'object') {
            const text = (part as { text?: unknown }).text;
            if (typeof text === 'string') chars += text.length;
          }
        }
      }
    }
  }
  return estimateTokens(chars);
}

/** Pre-call projected cost (micro-USD) — firewall isi se RESERVE karta hai. */
export function estimateProjectedCost(params: {
  model: string;
  messages?: ReadonlyArray<MessageLike> | null;
  system?: unknown;
  maxOutputTokens?: number;
}): number {
  const p = findPricing(params.model);
  const inTok = estimatePromptTokens(params.messages, params.system);
  const outTok = Math.max(1, params.maxOutputTokens ?? 512); // conservative default
  const usd = (p.inputUsdPerMillion * inTok + p.outputUsdPerMillion * outTok) / 1_000_000;
  return Math.round(usd * 1_000_000);
}