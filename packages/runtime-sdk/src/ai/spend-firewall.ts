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
  /** Hourly ceiling USD (e.g. from local env var). Takes precedence if set. 0/undefined = off. */
  ceilingUsdPerHour?: number;
  /** Store failures yahan — call FAIL-OPEN hoti hai. */
  onError?: (error: unknown) => void;
  /** Optional dynamic config fetcher (e.g. from GET /api/runtime/config). Refreshes every 5m. */
  configFetcher?: () => Promise<{ ceilingUsdPerHour?: number | null } | null | undefined>;
  /** Refresh interval in milliseconds (defaults to 5 minutes: 300,000 ms). */
  refreshIntervalMs?: number;
};

export class SpendFirewall {
  private remoteCeilingUsdPerHour: number | null = null;
  private lastFetchAt = 0;
  private isFetching = false;
  private readonly refreshIntervalMs: number;

  constructor(private readonly opts: SpendFirewallOptions) {
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 5 * 60 * 1000;
    if (this.opts.configFetcher) {
      void this.refreshConfig();
    }
  }

  /**
   * Refreshes the ceiling configuration from the remote fetcher.
   * On fetch failure: keeps the last known ceiling and passes error to onError.
   */
  async refreshConfig(): Promise<void> {
    if (!this.opts.configFetcher || this.isFetching) return;
    this.isFetching = true;
    try {
      const res = await this.opts.configFetcher();
      if (res && typeof res.ceilingUsdPerHour === 'number' && res.ceilingUsdPerHour > 0) {
        this.remoteCeilingUsdPerHour = res.ceilingUsdPerHour;
      } else if (res && (res.ceilingUsdPerHour === null || res.ceilingUsdPerHour === 0)) {
        this.remoteCeilingUsdPerHour = null;
      }
      this.lastFetchAt = Date.now();
    } catch (err) {
      this.opts.onError?.(err);
      // Fail-safe: keep last known ceiling (or disabled if never fetched)
      this.lastFetchAt = Date.now();
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Effective ceiling in USD/hour.
   * Env var ceiling (opts.ceilingUsdPerHour) takes precedence over remote config.
   */
  get effectiveCeilingUsdPerHour(): number {
    if (this.opts.ceilingUsdPerHour != null && this.opts.ceilingUsdPerHour > 0) {
      return this.opts.ceilingUsdPerHour;
    }
    return this.remoteCeilingUsdPerHour ?? 0;
  }

  get enabled(): boolean {
    return this.effectiveCeilingUsdPerHour > 0;
  }

  private get ceilingMicroUsd(): number {
    return Math.round(this.effectiveCeilingUsdPerHour * 1_000_000);
  }

  /** Triggers background refresh if 5 minutes have elapsed since last fetch. */
  private maybeRefresh(): void {
    if (this.opts.configFetcher && Date.now() - this.lastFetchAt >= this.refreshIntervalMs) {
      void this.refreshConfig(); // fire-and-forget
    }
  }

  /** Reserve-then-throw. Store failure → silent pass (fail-open) + onError. */
  async check(attemptedMicroUsd: number): Promise<void> {
    this.maybeRefresh();
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
    this.maybeRefresh();
    if (!this.enabled || attemptedMicroUsd <= 0) return;
    try {
      await this.opts.store.refundMicroUsd(hourKey(this.opts.projectId), attemptedMicroUsd);
    } catch (e) {
      this.opts.onError?.(e);
    }
  }
}

export type RemoteConfigFetcherOptions = {
  configUrl: string;
  projectId: string;
  signingSecret?: string;
  host?: string;
};

/**
 * Creates a standard configFetcher for SpendFirewall that calls /api/runtime/config.
 */
export function createRemoteConfigFetcher(
  opts: RemoteConfigFetcherOptions,
): () => Promise<{ ceilingUsdPerHour: number | null }> {
  return async () => {
    const headers: Record<string, string> = {
      'x-runtime-project-id': opts.projectId,
      'x-runtime-timestamp': String(Date.now()),
    };
    if (opts.signingSecret) {
      headers['x-runtime-signature'] = opts.signingSecret;
    }
    if (opts.host) {
      headers['x-runtime-host'] = opts.host;
    }

    const res = await fetch(opts.configUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch runtime config: ${res.status}`);
    }

    const data = (await res.json()) as { ceilingUsdPerHour?: number | null };
    return { ceilingUsdPerHour: data.ceilingUsdPerHour ?? null };
  };
}