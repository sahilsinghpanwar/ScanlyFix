import { getModelPricingCatalog, type CatalogEntry } from '@scanlyfix/db';
import {
  FALLBACK_PRICING,
  MODEL_PRICING,
  type ModelPricing,
} from '@scanlyfix/runtime-sdk';

export type { CatalogEntry, ModelPricing };

const CATALOG_TTL_MS = 5 * 60 * 1000; // 5-minute per-process memoization TTL
const MAX_CATALOG_ENTRIES = 2000;

let cachedCatalog: CatalogEntry[] | null = null;
let cacheExpiresAt = 0;

/**
 * Normalizes and strips provider prefixes ('openai/gpt-4o' -> 'gpt-4o').
 */
export function cleanModelName(model: string): string {
  if (typeof model !== 'string') return '';
  const trimmed = model.trim().toLowerCase();
  // Strip common provider prefixes
  return trimmed.replace(/^(openai|anthropic|azure|bedrock|groq|together_ai|deepseek|google)[/:]/, '');
}

/**
 * Pure transform function for LiteLLM pricing JSON.
 * - Keeps entries where input_cost_per_token and output_cost_per_token are numbers >= 0
 * - Converts per-token → per-million (multiplies by 1e6, rounds to 2 decimals)
 * - Strips provider prefix ('openai/gpt-4o' → 'gpt-4o')
 * - Bare keys take priority over provider-qualified duplicates
 * - Capped at 2000 entries
 */
export function transformLiteLlmCatalog(
  rawJson: Record<string, unknown> | null | undefined,
): CatalogEntry[] {
  if (!rawJson || typeof rawJson !== 'object') return [];

  const map = new Map<
    string,
    { model: string; inputUsdPerMillion: number; outputUsdPerMillion: number; isBare: boolean }
  >();

  for (const [rawKey, rawVal] of Object.entries(rawJson)) {
    if (!rawVal || typeof rawVal !== 'object') continue;
    const entry = rawVal as Record<string, unknown>;

    const inCost = entry.input_cost_per_token;
    const outCost = entry.output_cost_per_token;

    // Filter: keep entries where both input_cost_per_token and output_cost_per_token are numbers >= 0
    if (
      typeof inCost !== 'number' ||
      typeof outCost !== 'number' ||
      !Number.isFinite(inCost) ||
      !Number.isFinite(outCost) ||
      inCost < 0 ||
      outCost < 0
    ) {
      continue;
    }

    // Convert per-token -> per-million, round to 2 decimals
    const inputUsdPerMillion = Math.round(inCost * 1e6 * 100) / 100;
    const outputUsdPerMillion = Math.round(outCost * 1e6 * 100) / 100;

    // Strip provider prefix: if '/' exists, strip prefix; otherwise it's bare
    const hasSlash = rawKey.includes('/');
    const isBare = !hasSlash;
    const stripped = (hasSlash ? rawKey.slice(rawKey.indexOf('/') + 1) : rawKey).trim().toLowerCase();

    if (!stripped) continue;

    const existing = map.get(stripped);
    if (!existing) {
      map.set(stripped, {
        model: stripped,
        inputUsdPerMillion,
        outputUsdPerMillion,
        isBare,
      });
    } else if (isBare && !existing.isBare) {
      // Bare keys take priority over provider-qualified duplicates
      map.set(stripped, {
        model: stripped,
        inputUsdPerMillion,
        outputUsdPerMillion,
        isBare: true,
      });
    }
  }

  // Cap at 2000 entries
  return Array.from(map.values())
    .slice(0, MAX_CATALOG_ENTRIES)
    .map(({ model, inputUsdPerMillion, outputUsdPerMillion }) => ({
      model,
      inputUsdPerMillion,
      outputUsdPerMillion,
    }));
}

/**
 * Resolves pricing according to strict precedence order:
 * 1. Curated table (`MODEL_PRICING`) - longest prefix match
 * 2. LiteLLM catalog - exact match first, then longest prefix match
 * 3. Conservative fallback (`FALLBACK_PRICING` $3.00 in / $15.00 out)
 */
export function resolveModelPricing(
  model: string,
  catalog: ReadonlyArray<CatalogEntry> = [],
): ModelPricing {
  const m = cleanModelName(model);

  // ── 1. Curated table check ────────────────────────────────────────────────
  let curatedMatch: ModelPricing | null = null;
  for (const p of MODEL_PRICING) {
    if (m.startsWith(p.match) && p.match.length > (curatedMatch ? curatedMatch.match.length : -1)) {
      curatedMatch = p;
    }
  }
  if (curatedMatch) {
    return curatedMatch;
  }

  // ── 2. Catalog check (exact match first, then longest prefix) ─────────────
  const exactCatalog = catalog.find((c) => c.model.toLowerCase() === m);
  if (exactCatalog) {
    return {
      match: exactCatalog.model,
      inputUsdPerMillion: exactCatalog.inputUsdPerMillion,
      outputUsdPerMillion: exactCatalog.outputUsdPerMillion,
    };
  }

  let bestCatalog: CatalogEntry | null = null;
  for (const c of catalog) {
    const cModel = c.model.toLowerCase();
    if (m.startsWith(cModel) && cModel.length > (bestCatalog ? bestCatalog.model.length : -1)) {
      bestCatalog = c;
    }
  }
  if (bestCatalog) {
    return {
      match: bestCatalog.model,
      inputUsdPerMillion: bestCatalog.inputUsdPerMillion,
      outputUsdPerMillion: bestCatalog.outputUsdPerMillion,
    };
  }

  // ── 3. Conservative fallback ──────────────────────────────────────────────
  return FALLBACK_PRICING;
}

/**
 * Returns the in-memory memoized LiteLLM pricing catalog with 5-minute TTL.
 */
export async function getCachedModelCatalog(): Promise<CatalogEntry[]> {
  const now = Date.now();
  if (cachedCatalog !== null && now < cacheExpiresAt) {
    return cachedCatalog;
  }

  try {
    const row = await getModelPricingCatalog();
    cachedCatalog = row ?? [];
    cacheExpiresAt = now + CATALOG_TTL_MS;
  } catch (err) {
    if (cachedCatalog === null) {
      cachedCatalog = [];
    }
    // Brief 30s retry window on failure to avoid stampeding DB
    cacheExpiresAt = now + 30_000;
  }

  return cachedCatalog;
}

/** Clear the in-memory catalog cache (used in tests or manual reloads). */
export function clearModelCatalogCache(): void {
  cachedCatalog = null;
  cacheExpiresAt = 0;
}

/** Set the in-memory catalog cache (useful for testing or warming cache). */
export function setModelCatalogCache(catalog: CatalogEntry[], ttlMs = CATALOG_TTL_MS): void {
  cachedCatalog = catalog;
  cacheExpiresAt = Date.now() + ttlMs;
}

/**
 * Calculates estimated cost in micro-USD on the server using the full resolution hierarchy:
 * Curated table → LiteLLM catalog → Conservative fallback.
 */
export async function estimateServerCostMicroUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  overrideCatalog?: CatalogEntry[],
): Promise<number> {
  const catalog = overrideCatalog ?? (await getCachedModelCatalog());
  const pricing = resolveModelPricing(model, catalog);
  const usd =
    (pricing.inputUsdPerMillion * promptTokens + pricing.outputUsdPerMillion * completionTokens) / 1_000_000;
  return Math.round(usd * 1_000_000);
}
