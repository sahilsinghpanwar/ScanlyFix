/** PURE — live window se hourly velocity. Runaway loop MINUTES me pakda jata hai. */

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
    return { projectedHourlyMicroUsd: projected, pctOfCeiling: null, shouldAlert: false };
  }
  const pct = Math.round((projected / input.ceilingMicroUsd) * 100);
  return {
    projectedHourlyMicroUsd: projected,
    pctOfCeiling: pct,
    shouldAlert: pct >= (input.alertAtPctOfCeiling ?? 80),
  };
}