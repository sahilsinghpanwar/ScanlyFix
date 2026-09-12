export type TargetSource = 'default' | 'guard' | 'manual';
export type FindingSeverity = 'critical' | 'high';

export type ProbeVariant = 'logged_out' | 'anon_role';
export type FindingVariant = 'anon_role' | null;

export type ProbeOutcome =
  | { ok: true; status: number }
  | { ok: false; error: string };

/** Har target ka runtime verdict — discriminated union, exhaustive switch possible. */
export type TargetVerdict =
  | { verdict: 'baseline_recorded'; status: number }
  | { verdict: 'protected'; status: number }
  | { verdict: 'open'; status: number; severity: FindingSeverity }
  | { verdict: 'anon_open'; status: number; anonStatus: number; severity: FindingSeverity }
  | { verdict: 'inconclusive'; status: number }
  | { verdict: 'error'; error: string };

export type ProberFindingItem = {
  path: string;
  severity: FindingSeverity;
  baselineStatus: number;
  actualStatus: number;
  variant?: 'anon_role' | null;
  keyFingerprint?: string | null;
};

export type ProberRunSummary = {
  projectId: string;
  ranAt: string;
  baselinesRecorded: number;
  checked: number;
  newFindings: number;
  autoResolved: number;
  stillOpen: number;
  errors: number;
};

export const PROBE_USER_AGENT = 'ScanlyFixAuthProber/1.0 (+https://scanlyfix.com/bot)';
export const PROBE_TIMEOUT_MS = 10_000;
export const MAX_TARGETS_PER_PROJECT = 50;
export const PROBE_PARALLELISM = 5;