// classify.ts — FINAL (isko use karo)
import type { FindingSeverity, TargetVerdict } from './types';
export * from './flap';

export function isProtectedStatus(status: number): boolean {
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

export function isOpenStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [/^\/admin/i, /^\/internal/i, /^\/api\//i, /^\/\.(env|git)/i];

export function severityForPath(path: string): FindingSeverity {
  return SENSITIVE_PATTERNS.some((re) => re.test(path)) ? 'critical' : 'high';
}

/**
 * Pure decision function — path + baseline + actual → verdict.
 * Isi ko unit-test karte hain; network ka kahin role nahi.
 */
export function evaluateTarget(params: {
  path: string;
  baseline: number | null;
  actual: number;
  anonActual?: number | null;
}): TargetVerdict {
  const { path, baseline, actual, anonActual } = params;

  if (baseline === null) return { verdict: 'baseline_recorded', status: actual };

  const baselineWasProtected = isProtectedStatus(baseline);
  const actualIsOpen = isOpenStatus(actual);
  const actualIsProtected = isProtectedStatus(actual);

  if (baselineWasProtected && actualIsOpen) {
    return { verdict: 'open', status: actual, severity: severityForPath(path) };
  }

  if (actualIsProtected) {
    if (anonActual !== undefined && anonActual !== null && isOpenStatus(anonActual)) {
      return {
        verdict: 'anon_open',
        status: actual,
        anonStatus: anonActual,
        severity: severityForPath(path),
      };
    }
    return { verdict: 'protected', status: actual };
  }

  if (actualIsOpen) return { verdict: 'open', status: actual, severity: severityForPath(path) };
  return { verdict: 'inconclusive', status: actual };
}