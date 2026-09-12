/**
 * Model pricing — SDK aur server DONO isi module se compute karte hain.
 * Isi se ye promise prove hota hai:
 *   "the figure that trips a ceiling and the figure on screen are the same figure"
 *
 * FALLBACK (fail-safe direction): unknown model ko expensive generic rate milta hai —
 *   kabhi 0 nahi. Galat ho to OVER-estimate hota hai, under kabhi nahi —
 *   isliye firewall kisi unknown model ko free-rein nahi dega.
 *
 * Rates: USD per 1M tokens (public list prices). Float yahan safe hai —
 * single rounding point hai (estimateCostMicroUsd ke final Math.round par).
 */

export type ModelPricing = {
  /** Prefix match — version suffixes tolerant: "gpt-4o" → "gpt-4o-2024-08-06" bhi pakdega */
  match: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export const MODEL_PRICING: ReadonlyArray<ModelPricing> = [
  { match: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  { match: 'gpt-4o', inputUsdPerMillion: 2.5, outputUsdPerMillion: 10.0 },
  { match: 'gpt-4.1-mini', inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
  { match: 'gpt-4.1', inputUsdPerMillion: 2.0, outputUsdPerMillion: 8.0 },
  { match: 'gpt-4-turbo', inputUsdPerMillion: 10.0, outputUsdPerMillion: 30.0 },
  { match: 'gpt-3.5-turbo', inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 },
  { match: 'o1-mini', inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 },
  { match: 'o1', inputUsdPerMillion: 15.0, outputUsdPerMillion: 60.0 },
  { match: 'o3-mini', inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 },
  { match: 'o4-mini', inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 },
  { match: 'claude-3-5-haiku', inputUsdPerMillion: 0.8, outputUsdPerMillion: 4.0 },
  { match: 'claude-3-haiku', inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.25 },
  { match: 'claude-3-7-sonnet', inputUsdPerMillion: 3.0, outputUsdPerMillion: 15.0 },
  { match: 'claude-3-5-sonnet', inputUsdPerMillion: 3.0, outputUsdPerMillion: 15.0 },
  { match: 'claude-3-opus', inputUsdPerMillion: 15.0, outputUsdPerMillion: 75.0 },
];

/** Known flagship average — unknown models ka conservative stand-in. */
export const FALLBACK_PRICING: ModelPricing = {
  match: '*',
  inputUsdPerMillion: 3.0,
  outputUsdPerMillion: 15.0,
};

/** Sabse-lambe match ki jeet — "gpt-4o-mini" ko "gpt-4o" ke rate par nahi jaane denge. */
export function findPricing(model: string): ModelPricing {
  const raw = typeof model === 'string' ? model.toLowerCase().trim() : '';
  const m = raw.replace(/^(openai|anthropic)[/:]/, '');
  let best: ModelPricing = FALLBACK_PRICING;
  for (const p of MODEL_PRICING) {
    if (m.startsWith(p.match) && p.match.length > (best.match === '*' ? -1 : best.match.length)) {
      best = p;
    }
  }
  return best; // ⭐ kabhi null NAHI — unknown → fallback
}

/** micro-USD cost (1 USD = 1e6 micro-USD). Unknown model → fallback rate. HAMESHA number. */
export function estimateCostMicroUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = findPricing(model);
  const usd = (p.inputUsdPerMillion * promptTokens + p.outputUsdPerMillion * completionTokens) / 1_000_000;
  return Math.round(usd * 1_000_000);
}