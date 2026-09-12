import { describe, expect, it, vi } from 'vitest';

import { MemorySpendStore, SpendCeilingError, SpendFirewall, hourKey, type SpendStore } from '../src/ai/spend-firewall.ts';

const fw = (ceilingUsd: number, onError?: (e: unknown) => void) =>
  new SpendFirewall({ projectId: 'p1', store: new MemorySpendStore(), ceilingUsdPerHour: ceilingUsd, onError });

describe('SpendFirewall', () => {
  it('ceiling ke andar → allow', async () => {
    await expect(fw(1).check(100_000)).resolves.toBeUndefined();
  });

  it('ceiling cross → SpendCeilingError (reservation ke saath)', async () => {
    const f = fw(1);
    await f.check(900_000);
    await expect(f.check(200_000)).rejects.toBeInstanceOf(SpendCeilingError);
  });

  it('refund ke baad ceiling wapas available', async () => {
    const f = fw(1);
    await f.check(1_000_000);
    await f.refund(1_000_000);
    await expect(f.check(500_000)).resolves.toBeUndefined();
  });

  it('store fail → FAIL-OPEN (AI call hostage nahi)', async () => {
    const onError = vi.fn();
    const broken: SpendStore = {
      addMicroUsd: async () => { throw new Error('down'); },
      refundMicroUsd: async () => {},
    };
    const f = new SpendFirewall({ projectId: 'p', store: broken, ceilingUsdPerHour: 1, onError });
    await expect(f.check(5_000_000)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('ceiling 0 → off', async () => {
    await expect(fw(0).check(999_999_999)).resolves.toBeUndefined();
  });

  it('hourKey hour-granular (auto-reset)', () => {
    expect(hourKey('p', new Date('2026-03-01T05:59:00Z'))).not.toBe(hourKey('p', new Date('2026-03-01T06:00:00Z')));
  });

  describe('Dynamic configFetcher', () => {
    it('sets ceiling dynamically from configFetcher', async () => {
      const configFetcher = vi.fn().mockResolvedValue({ ceilingUsdPerHour: 2.5 });
      const f = new SpendFirewall({
        projectId: 'p-dyn',
        store: new MemorySpendStore(),
        configFetcher,
      });

      // Await initial background fetch
      await f.refreshConfig();

      expect(f.effectiveCeilingUsdPerHour).toBe(2.5);
      expect(f.enabled).toBe(true);

      // 2,000,000 micro-USD ($2.00) should pass under $2.50
      await expect(f.check(2_000_000)).resolves.toBeUndefined();
      // Additional 1,000,000 micro-USD brings total to $3.00 > $2.50 ceiling -> should reject
      await expect(f.check(1_000_000)).rejects.toBeInstanceOf(SpendCeilingError);
    });

    it('env var ceiling takes precedence over configFetcher if both are set', async () => {
      // Local env var ceiling is $1.00; remote config returns $10.00
      const configFetcher = vi.fn().mockResolvedValue({ ceilingUsdPerHour: 10 });
      const f = new SpendFirewall({
        projectId: 'p-precedence',
        store: new MemorySpendStore(),
        ceilingUsdPerHour: 1.0, // Env var override
        configFetcher,
      });

      await f.refreshConfig();

      // Env var must take precedence!
      expect(f.effectiveCeilingUsdPerHour).toBe(1.0);

      // $1.50 must exceed $1.00 even though remote says $10.00
      await expect(f.check(1_500_000)).rejects.toBeInstanceOf(SpendCeilingError);
    });

    it('keeps last known ceiling when configFetcher fails', async () => {
      const onError = vi.fn();
      let fetchCount = 0;
      const configFetcher = vi.fn().mockImplementation(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          return { ceilingUsdPerHour: 5.0 };
        }
        throw new Error('Network timeout');
      });

      const f = new SpendFirewall({
        projectId: 'p-failsafe',
        store: new MemorySpendStore(),
        configFetcher,
        onError,
      });

      // Initial successful fetch sets ceiling to $5.00
      await f.refreshConfig();
      expect(f.effectiveCeilingUsdPerHour).toBe(5.0);

      // Second fetch fails
      await f.refreshConfig();

      // Must keep last known ceiling ($5.00)
      expect(f.effectiveCeilingUsdPerHour).toBe(5.0);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('refreshes after 5-minute interval', async () => {
      vi.useFakeTimers();
      const configFetcher = vi
        .fn()
        .mockResolvedValueOnce({ ceilingUsdPerHour: 2.0 })
        .mockResolvedValueOnce({ ceilingUsdPerHour: 4.0 });

      const f = new SpendFirewall({
        projectId: 'p-refresh',
        store: new MemorySpendStore(),
        configFetcher,
      });

      await f.refreshConfig();
      expect(f.effectiveCeilingUsdPerHour).toBe(2.0);

      // Check within 5 minutes: does not call configFetcher again
      await f.check(100_000);
      expect(configFetcher).toHaveBeenCalledTimes(1);

      // Advance 5 minutes + 1 second
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

      // Next check triggers background refresh
      await f.check(100_000);
      // Let any pending microtasks resolve
      await Promise.resolve();

      expect(configFetcher).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });
});