import { describe, expect, it } from 'vitest';

import { estimateCostMicroUsd, findPricing, FALLBACK_PRICING } from '../src/ai/pricing.ts';

describe('pricing', () => {
  it('exact + version-suffix models match hote hain', () => {
    expect(findPricing('gpt-4o-mini').match).toBe('gpt-4o-mini');
    expect(findPricing('gpt-4o-mini-2024-07-18').match).toBe('gpt-4o-mini');
    expect(findPricing('claude-3-5-sonnet-20241022').match).toBe('claude-3-5-sonnet');
    expect(findPricing('claude-3-7-sonnet-20250219').match).toBe('claude-3-7-sonnet');
    expect(findPricing('o1-mini-2024-09-12').match).toBe('o1-mini');
  });

  it('provider prefix tolerant (openai/gpt-4o-mini, anthropic/claude-3-5-sonnet)', () => {
    expect(findPricing('openai/gpt-4o-mini').match).toBe('gpt-4o-mini');
    expect(findPricing('anthropic/claude-3-5-sonnet').match).toBe('claude-3-5-sonnet');
    expect(findPricing('openai:o3-mini').match).toBe('o3-mini');
  });

  it('safely handles empty or undefined model without throwing', () => {
    expect(findPricing(undefined as unknown as string)).toBe(FALLBACK_PRICING);
    expect(findPricing('')).toBe(FALLBACK_PRICING);
  });

  it('sabse-lambe match jeet-ta hai (mini ko parent ka rate nahi)', () => {
    expect(findPricing('gpt-4o-mini').inputUsdPerMillion).toBe(0.15);
    expect(findPricing('gpt-4o-mini').inputUsdPerMillion).not.toBe(2.5);
  });

  it('⭐ unknown model → FALLBACK (kabhi null nahi) — firewall kabhi andha nahi', () => {
    const p = findPricing('gemini-1.5-pro');
    expect(p).toBe(FALLBACK_PRICING);
    expect(estimateCostMicroUsd('totally-unknown-model', 1000, 1000)).toBeGreaterThan(0);
  });

  it('cost math: 100 in + 50 out gpt-4o-mini = 45 micro-USD', () => {
    expect(estimateCostMicroUsd('gpt-4o-mini', 100, 50)).toBe(45);
  });
});