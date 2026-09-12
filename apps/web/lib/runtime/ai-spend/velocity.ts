/** PURE — live window se hourly velocity. Runaway loop MINUTES me pakda jata hai. */

/** Default absolute velocity threshold for projects without a custom ceiling ($10.00 / hour). */
export const DEFAULT_ABSOLUTE_THRESHOLD_USD = 10;
export const DEFAULT_ABSOLUTE_THRESHOLD_MICRO_USD = DEFAULT_ABSOLUTE_THRESHOLD_USD * 1_000_000;

export type VelocityInput = {
  windowMicroUsd: number;
  windowMinutes: number;
  ceilingMicroUsd: number | null;
  /** Alert threshold (% of ceiling). Default 80. */
  alertAtPctOfCeiling?: number;
};

export type VelocityVerdict = {
  projectedHourlyMicroUsd: number;
  pctOfCeiling: number | null;
  shouldAlert: boolean;
};

export function evaluateVelocity(input: VelocityInput): VelocityVerdict {
  if (input.windowMicroUsd <= 0 || input.windowMinutes <= 0) {
    return {
      projectedHourlyMicroUsd: 0,
      pctOfCeiling: input.ceilingMicroUsd && input.ceilingMicroUsd > 0 ? 0 : null,
      shouldAlert: false,
    };
  }

  const projected = Math.round((input.windowMicroUsd / input.windowMinutes) * 60);

  if (input.ceilingMicroUsd === null || input.ceilingMicroUsd <= 0) {
    // When no custom ceiling is configured, evaluate against the $10/hr default absolute threshold
    return {
      projectedHourlyMicroUsd: projected,
      pctOfCeiling: null,
      shouldAlert: projected >= DEFAULT_ABSOLUTE_THRESHOLD_MICRO_USD,
    };
  }

  const pct = Math.round((projected / input.ceilingMicroUsd) * 100);
  return {
    projectedHourlyMicroUsd: projected,
    pctOfCeiling: pct,
    shouldAlert: pct >= (input.alertAtPctOfCeiling ?? 80),
  };
}