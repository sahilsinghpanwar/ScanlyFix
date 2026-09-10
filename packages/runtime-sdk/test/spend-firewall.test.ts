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
});