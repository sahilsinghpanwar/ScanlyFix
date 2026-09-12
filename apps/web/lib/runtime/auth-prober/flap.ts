export interface FindingHistoryItem {
  path: string;
  createdAt: Date | string;
}

export interface FlapOptions {
  /** Reference timestamp for the analysis window. Defaults to current date/time. */
  now?: Date | string;
  /** Lookback window in days. Defaults to 30 days. */
  windowDays?: number;
  /** Number of regressions within the window required to flag as unstable. Defaults to 3. */
  threshold?: number;
}

export interface FlapAnalysisResult {
  /** Map of normalized path to the count of regressions within the window. */
  regressionCounts: Record<string, number>;
  /** Set of paths that regressed >= threshold times within windowDays. */
  unstablePaths: Set<string>;
  /** Check whether a specific path is currently flapping/unstable. */
  isUnstable: (path: string) => boolean;
  /** Returns 'unstable' if regressed >= threshold times in window, otherwise 'stable'. */
  getFlapStatus: (path: string) => 'unstable' | 'stable';
}

/**
 * Pure function: calculates the age in days of a recorded baseline.
 * Returns null if no baseline has been recorded yet.
 */
export function calculateBaselineAgeDays(
  baselineAt: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!baselineAt) return null;
  const baselineTime = new Date(baselineAt).getTime();
  if (isNaN(baselineTime)) return null;
  const diffMs = now.getTime() - baselineTime;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Pure function: Given findings history, if the same path regressed
 * >= 3 times in 30 days (default), returns 'unstable' flag and analysis set.
 */
export function detectFlappingPaths(
  findings: FindingHistoryItem[],
  options?: FlapOptions,
): FlapAnalysisResult {
  const now = options?.now ? new Date(options.now) : new Date();
  const windowDays = options?.windowDays ?? 30;
  const threshold = options?.threshold ?? 3;

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoffTime = now.getTime() - windowMs;

  const regressionCounts: Record<string, number> = {};
  const unstablePaths = new Set<string>();

  for (const finding of findings) {
    if (!finding?.path || !finding.createdAt) continue;
    const createdAtTime = new Date(finding.createdAt).getTime();
    if (isNaN(createdAtTime)) continue;

    // Only count regressions that occurred within the time window
    if (createdAtTime >= cutoffTime && createdAtTime <= now.getTime()) {
      const normalizedPath = finding.path.trim();
      regressionCounts[normalizedPath] = (regressionCounts[normalizedPath] ?? 0) + 1;
      if (regressionCounts[normalizedPath] >= threshold) {
        unstablePaths.add(normalizedPath);
      }
    }
  }

  return {
    regressionCounts,
    unstablePaths,
    isUnstable: (path: string) => unstablePaths.has(path.trim()),
    getFlapStatus: (path: string) => (unstablePaths.has(path.trim()) ? 'unstable' : 'stable'),
  };
}

/**
 * Pure convenience helper to check if an individual path has regressed >= threshold times in 30 days.
 */
export function isPathUnstable(
  path: string,
  findings: FindingHistoryItem[],
  options?: FlapOptions,
): boolean {
  if (!path) return false;
  const result = detectFlappingPaths(findings, options);
  return result.isUnstable(path);
}
