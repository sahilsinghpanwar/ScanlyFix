/**
 * "Needs a session" rule — CheckVibe ka exact idea:
 * real traffic lagbhag HAMESHA session ke saath aaya → route protected hai.
 */

/** 5% tolerance — ek-ok-luck logged-out request false signal nahi banegi. */
export const NEEDS_SESSION_MAX_OPEN_RATIO = 0.05;
/** 3 se kam samples = data nahi hai, guess mat karo. */
export const NEEDS_SESSION_MIN_SAMPLES = 3;

export function computeNeedsSession(
  withSession: number,
  withoutSession: number,
  source?: string | null,
): boolean {
  if (source === 'sample') return false;
  const total = withSession + withoutSession;
  if (total < NEEDS_SESSION_MIN_SAMPLES) return false;
  return withoutSession / total <= NEEDS_SESSION_MAX_OPEN_RATIO;
}

export type RouteStatEntry = {
  hour: Date | string;
  withSession: number;
  withoutSession: number;
};

/**
 * Evaluates whether a route needs a session based on recent hourly stats.
 *
 * Enforces:
 * 1. Time-window filtering (default 7 days: hour >= now - 7 days).
 * 2. Min-3-samples rule evaluated within the recent window only.
 * 3. Sample traffic isolation (source === 'sample' -> false).
 * 4. Max open ratio (<= 5%).
 */
export function computeNeedsSessionFromStats(
  stats: RouteStatEntry[],
  options?: {
    windowDays?: number;
    now?: Date;
    source?: string | null;
  },
): boolean {
  if (options?.source === 'sample') return false;

  const windowDays = options?.windowDays ?? 7;
  const now = options?.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 3600_000);

  let withSession = 0;
  let withoutSession = 0;

  for (const stat of stats) {
    const statHour = typeof stat.hour === 'string' ? new Date(stat.hour) : stat.hour;
    if (statHour.getTime() >= cutoff.getTime()) {
      withSession += stat.withSession;
      withoutSession += stat.withoutSession;
    }
  }

  return computeNeedsSession(withSession, withoutSession, options?.source);
}