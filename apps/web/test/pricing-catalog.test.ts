import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  transformLiteLlmCatalog,
  resolveModelPricing,
  estimateServerCostMicroUsd,
  getCachedModelCatalog,
  clearModelCatalogCache,
  setModelCatalogCache,
  type CatalogEntry,
} from '../lib/runtime/ai-pricing/server-pricing.ts';
import { MODEL_PRICING, FALLBACK_PRICING } from '@scanlyfix/runtime-sdk';
import { runtimePricingSync } from '../inngest/functions/runtime-pricing-sync.ts';

const mockGetModelPricingCatalog = vi.fn();
const mockUpsertModelPricingCatalog = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  getModelPricingCatalog: () => mockGetModelPricingCatalog(),
  upsertModelPricingCatalog: (...args: unknown[]) => mockUpsertModelPricingCatalog(...args),
}));

describe('LiteLLM Catalog Transform Function (transformLiteLlmCatalog)', () => {
  it('converts per-token costs to per-million and rounds to 2 decimals', () => {
    const raw = {
      'gpt-4o': {
        input_cost_per_token: 0.0000025, // 2.5 per million
        output_cost_per_token: 0.00001, // 10.0 per million
      },
      'sub-cent-model': {
        input_cost_per_token: 0.000000155, // 0.155 -> rounds to 0.16
        output_cost_per_token: 0.000000604, // 0.604 -> rounds to 0.60
      },
    };

    const result = transformLiteLlmCatalog(raw);
    expect(result).toHaveLength(2);

    const gpt4o = result.find((r) => r.model === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.inputUsdPerMillion).toBe(2.5);
    expect(gpt4o?.outputUsdPerMillion).toBe(10);

    const subCent = result.find((r) => r.model === 'sub-cent-model');
    expect(subCent?.inputUsdPerMillion).toBe(0.16);
    expect(subCent?.outputUsdPerMillion).toBe(0.6);
  });

  it('strips provider prefix from model names', () => {
    const raw = {
      'openai/gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 },
      'anthropic/claude-3-5-sonnet-20241022': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
      'bedrock/meta.llama3-70b-instruct-v1:0': {
        input_cost_per_token: 0.00000265,
        output_cost_per_token: 0.0000035,
      },
    };

    const result = transformLiteLlmCatalog(raw);
    const models = result.map((r) => r.model);
    expect(models).toContain('gpt-4o');
    expect(models).toContain('claude-3-5-sonnet-20241022');
    expect(models).toContain('meta.llama3-70b-instruct-v1:0');
  });

  it('skips entries with null, undefined, negative, or non-numeric costs', () => {
    const raw = {
      'valid-model': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      'sample_spec': { input_cost_per_token: 'None', output_cost_per_token: 'None' },
      'null-in-cost': { input_cost_per_token: null, output_cost_per_token: 0.000002 },
      'missing-out-cost': { input_cost_per_token: 0.000001 },
      'negative-cost': { input_cost_per_token: -0.000001, output_cost_per_token: 0.000002 },
      'nan-cost': { input_cost_per_token: NaN, output_cost_per_token: 0.000002 },
    };

    const result = transformLiteLlmCatalog(raw as Record<string, unknown>);
    expect(result).toHaveLength(1);
    expect(result[0]?.model).toBe('valid-model');
  });

  it('bare keys take priority over provider-qualified duplicates regardless of order', () => {
    // Case A: provider-qualified first, bare key second
    const rawA = {
      'openai/gpt-4o': { input_cost_per_token: 0.000005, output_cost_per_token: 0.00002 }, // qualified ($5/$20)
      'gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 }, // bare ($2.5/$10)
    };
    const resultA = transformLiteLlmCatalog(rawA);
    const entryA = resultA.find((r) => r.model === 'gpt-4o');
    expect(entryA?.inputUsdPerMillion).toBe(2.5);
    expect(entryA?.outputUsdPerMillion).toBe(10);

    // Case B: bare key first, provider-qualified second
    const rawB = {
      'gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 }, // bare ($2.5/$10)
      'azure/gpt-4o': { input_cost_per_token: 0.000008, output_cost_per_token: 0.00003 }, // qualified ($8/$30)
    };
    const resultB = transformLiteLlmCatalog(rawB);
    const entryB = resultB.find((r) => r.model === 'gpt-4o');
    expect(entryB?.inputUsdPerMillion).toBe(2.5);
    expect(entryB?.outputUsdPerMillion).toBe(10);
  });

  it('caps catalog at 2000 entries', () => {
    const bigRaw: Record<string, unknown> = {};
    for (let i = 0; i < 2500; i++) {
      bigRaw[`model-${i}`] = {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      };
    }

    const result = transformLiteLlmCatalog(bigRaw);
    expect(result).toHaveLength(2000);
  });

  it('handles empty or non-object payloads cleanly', () => {
    expect(transformLiteLlmCatalog(null)).toEqual([]);
    expect(transformLiteLlmCatalog(undefined)).toEqual([]);
    expect(transformLiteLlmCatalog({})).toEqual([]);
  });
});

describe('Pricing Resolution Order (resolveModelPricing & estimateServerCostMicroUsd)', () => {
  const sampleCatalog: CatalogEntry[] = [
    { model: 'gpt-4o-mini', inputUsdPerMillion: 99.0, outputUsdPerMillion: 99.0 }, // Catalog price should be overridden by curated
    { model: 'deepseek-chat', inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28 },
    { model: 'mistral-large', inputUsdPerMillion: 2.0, outputUsdPerMillion: 6.0 },
    { model: 'mistral-large-2407', inputUsdPerMillion: 3.0, outputUsdPerMillion: 9.0 },
  ];

  it('curated table beats catalog (even if catalog has a matching entry)', () => {
    // Curated table has gpt-4o-mini at $0.15 / $0.60
    // Catalog has gpt-4o-mini at $99.00 / $99.00
    const resolved = resolveModelPricing('gpt-4o-mini', sampleCatalog);
    expect(resolved.match).toBe('gpt-4o-mini');
    expect(resolved.inputUsdPerMillion).toBe(0.15); // Curated wins!
    expect(resolved.outputUsdPerMillion).toBe(0.6);
  });

  it('catalog beats fallback when model is not in curated table', () => {
    // deepseek-chat is not in curated table, but exists in catalog
    const resolved = resolveModelPricing('deepseek-chat', sampleCatalog);
    expect(resolved.match).toBe('deepseek-chat');
    expect(resolved.inputUsdPerMillion).toBe(0.14);
    expect(resolved.outputUsdPerMillion).toBe(0.28);
  });

  it('falls back to conservative fallback rate when not in curated or catalog', () => {
    const resolved = resolveModelPricing('completely-unknown-custom-model', sampleCatalog);
    expect(resolved.match).toBe(FALLBACK_PRICING.match);
    expect(resolved.inputUsdPerMillion).toBe(FALLBACK_PRICING.inputUsdPerMillion); // $3.00
    expect(resolved.outputUsdPerMillion).toBe(FALLBACK_PRICING.outputUsdPerMillion); // $15.00
  });

  it('exact catalog match beats prefix match', () => {
    // mistral-large-2407 matches exact mistral-large-2407 ($3/$9), not prefix mistral-large ($2/$6)
    const exact = resolveModelPricing('mistral-large-2407', sampleCatalog);
    expect(exact.inputUsdPerMillion).toBe(3.0);
    expect(exact.outputUsdPerMillion).toBe(9.0);

    // mistral-large matches exact mistral-large ($2/$6)
    const base = resolveModelPricing('mistral-large', sampleCatalog);
    expect(base.inputUsdPerMillion).toBe(2.0);
    expect(base.outputUsdPerMillion).toBe(6.0);
  });

  it('calculates cost micro-USD accurately via estimateServerCostMicroUsd', async () => {
    // 1000 prompt tokens, 500 completion tokens on deepseek-chat:
    // (0.14 * 1000 + 0.28 * 500) / 1e6 = (140 + 140) / 1e6 = 0.00028 USD = 280 micro-USD
    const cost = await estimateServerCostMicroUsd('deepseek-chat', 1000, 500, sampleCatalog);
    expect(cost).toBe(280);
  });
});

describe('Per-Process Catalog Memoization with 5-Minute TTL', () => {
  beforeEach(() => {
    clearModelCatalogCache();
    vi.clearAllMocks();
  });

  it('memoizes DB catalog response in memory across consecutive calls within TTL', async () => {
    const dbCatalog: CatalogEntry[] = [{ model: 'cached-model', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }];
    mockGetModelPricingCatalog.mockResolvedValueOnce(dbCatalog);

    const first = await getCachedModelCatalog();
    expect(first).toEqual(dbCatalog);
    expect(mockGetModelPricingCatalog).toHaveBeenCalledTimes(1);

    // Second call: should read from in-memory cache without hitting DB
    const second = await getCachedModelCatalog();
    expect(second).toEqual(dbCatalog);
    expect(mockGetModelPricingCatalog).toHaveBeenCalledTimes(1);
  });

  it('refreshes catalog from DB when 5-minute TTL expires', async () => {
    vi.useFakeTimers();
    const initialCatalog: CatalogEntry[] = [{ model: 'old-model', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }];
    const refreshedCatalog: CatalogEntry[] = [{ model: 'new-model', inputUsdPerMillion: 3, outputUsdPerMillion: 4 }];

    mockGetModelPricingCatalog
      .mockResolvedValueOnce(initialCatalog)
      .mockResolvedValueOnce(refreshedCatalog);

    const first = await getCachedModelCatalog();
    expect(first).toEqual(initialCatalog);

    // Advance 4 minutes (still within 5m TTL)
    vi.advanceTimersByTime(4 * 60 * 1000);
    const cached = await getCachedModelCatalog();
    expect(cached).toEqual(initialCatalog);
    expect(mockGetModelPricingCatalog).toHaveBeenCalledTimes(1);

    // Advance past 5 minutes (TTL expired)
    vi.advanceTimersByTime(2 * 60 * 1000);
    const updated = await getCachedModelCatalog();
    expect(updated).toEqual(refreshedCatalog);
    expect(mockGetModelPricingCatalog).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe('Inngest runtime/pricing-sync Function', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully fetches, transforms, and upserts catalog on weekly sync', async () => {
    const mockJson = {
      'groq/llama-3-8b': { input_cost_per_token: 0.00000005, output_cost_per_token: 0.00000008 },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockJson,
    });
    vi.stubGlobal('fetch', mockFetch);

    const mockStep = {
      run: vi.fn(async (name: string, fn: () => unknown) => fn()),
    };
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const fn = (runtimePricingSync as unknown as {
      fn: (ctx: { step: typeof mockStep; logger: typeof mockLogger }) => Promise<{ ok: boolean; entryCount?: number }>;
    }).fn;

    const result = await fn({ step: mockStep, logger: mockLogger });
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(1);
    expect(mockUpsertModelPricingCatalog).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('fails open without throwing when fetch fails or returns non-200, logging warning', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });
    vi.stubGlobal('fetch', mockFetch);

    const mockStep = {
      run: vi.fn(async (name: string, fn: () => unknown) => fn()),
    };
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const fn = (runtimePricingSync as unknown as {
      fn: (ctx: { step: typeof mockStep; logger: typeof mockLogger }) => Promise<{ ok: boolean; reason?: string }>;
    }).fn;

    // Must NOT throw
    const result = await fn({ step: mockStep, logger: mockLogger });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('HTTP_503');
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockUpsertModelPricingCatalog).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('fails open without throwing when fetch throws an error (e.g. timeout)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('AbortError: The operation timed out'));
    vi.stubGlobal('fetch', mockFetch);

    const mockStep = {
      run: vi.fn(async (name: string, fn: () => unknown) => fn()),
    };
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const fn = (runtimePricingSync as unknown as {
      fn: (ctx: { step: typeof mockStep; logger: typeof mockLogger }) => Promise<{ ok: boolean; reason?: string }>;
    }).fn;

    const result = await fn({ step: mockStep, logger: mockLogger });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fetch_or_transform_error');
    expect(mockLogger.warn).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
