/**
 * SPEND FIREWALL —  admitted gap:
 *   "no ceiling can be set to blocking yet, so today it records instead."
 * Hum block karte hain:
 *
 *   check(projected) → counter me ADD (reserve) → total > ceiling? THROW (provider tak call nahi)
 *   provider error   → refund(projected) — outage se ceiling lock-out nahi
 *
 * Fail-open policy: store down → call jaati hai (onError log) — telemetry kabhi
 * AI call ko hostage nahi leti (CheckVibe wala core promise, retained).
 */

export interface SpendStore {
  /** Atomically add; NEW total return kare. */
  addMicroUsd(key: string, amountMicroUsd: number): Promise<number>;
  /** Subtract (refund), clamped ≥ 0. */
  refundMicroUsd(key: string, amountMicroUsd: number): Promise<void>;
}

/** Zero-config, per-process. Runaway loop realistically EK process me hota hai. */
export class MemorySpendStore implements SpendStore {
  private totals = new Map<string, number>();

  async addMicroUsd(key: string, amount: number): Promise<number> {
    if (this.totals.size > 100) {
      const cutoff = `spend:${key.split(':')[1] ?? ''}:${new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 13)}`;
      for (const k of this.totals.keys()) {
        if (k < cutoff) this.totals.delete(k);
      }
    }
    const next = (this.totals.get(key) ?? 0) + amount;
    this.totals.set(key, next);
    return next;
  }

  async refundMicroUsd(key: string, amount: number): Promise<void> {
    const next = Math.max(0, (this.totals.get(key) ?? 0) - amount);
    this.totals.set(key, next);
  }
}

/** Upstash Redis REST — multi-instance accurate; sirf fetch, zero deps. */
export function createUpstashStore(url: string, token: string): SpendStore {
  async function command(...args: (string | number)[]): Promise<unknown> {
    const res = await fetch(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  }
  return {
    async addMicroUsd(key, amount) {
      const n = (await command('INCRBYFLOAT', key, amount)) as number;
      await command('EXPIRE', key, 7200).catch(() => {}); // 2h TTL — hour-key GC
      return Number(n);
    },
    async refundMicroUsd(key, amount) {
      await command('INCRBYFLOAT', key, -amount).catch(() => {}); // best-effort
    },
  };
}

/** Hour-granular key → ceiling har ghante auto-reset. */
export function hourKey(projectId: string, date: Date = new Date()): string {
  return `spend:${projectId}:${date.toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
}

/** Named error — CheckVibe promise: "a named error, never a fake answer". */
export class SpendCeilingError extends Error {
  override name = 'SpendCeilingError';
  constructor(
    public readonly ceilingMicroUsd: number,
    public readonly attemptedMicroUsd: number,
    public readonly totalAfterReserveMicroUsd: number,
  ) {
    super(
      `AI spend ceiling hit: projected $${(attemptedMicroUsd / 1e6).toFixed(4)} would take this ` +
        `hour to $${(totalAfterReserveMicroUsd / 1e6).toFixed(4)} (ceiling $${(ceilingMicroUsd / 1e6).toFixed(2)}). ` +
        `Refused BEFORE the provider — no money spent.`,
    );
  }
}

export type SpendFirewallOptions = {
  projectId: string;
  store: SpendStore;
  /** Hourly ceiling USD. 0/undefined = off. */
  ceilingUsdPerHour?: number;
  /** Store failures yahan — call FAIL-OPEN hoti hai. */
  onError?: (error: unknown) => void;
};

export class SpendFirewall {
  constructor(private readonly opts: SpendFirewallOptions) {}

  get enabled(): boolean {
    return (this.opts.ceilingUsdPerHour ?? 0) > 0;
  }

  private get ceilingMicroUsd(): number {
    return Math.round((this.opts.ceilingUsdPerHour ?? 0) * 1_000_000);
  }

  /** Reserve-then-throw. Store failure → silent pass (fail-open) + onError. */
  async check(attemptedMicroUsd: number): Promise<void> {
    if (!this.enabled || attemptedMicroUsd <= 0) return;
    try {
      const total = await this.opts.store.addMicroUsd(hourKey(this.opts.projectId), attemptedMicroUsd);
      if (total > this.ceilingMicroUsd) throw new SpendCeilingError(this.ceilingMicroUsd, attemptedMicroUsd, total);
    } catch (e) {
      if (e instanceof SpendCeilingError) {
        await this.opts.store.refundMicroUsd(hourKey(this.opts.projectId), attemptedMicroUsd).catch(() => {});
        throw e; // ⭐ yahi BLOCK hai
      }
      this.opts.onError?.(e);
    }
  }

  /** Provider fail → reservation wapas. */
  async refund(attemptedMicroUsd: number): Promise<void> {
    if (!this.enabled || attemptedMicroUsd <= 0) return;
    try {
      await this.opts.store.refundMicroUsd(hourKey(this.opts.projectId), attemptedMicroUsd);
    } catch (e) {
      this.opts.onError?.(e);
    }
  }
}