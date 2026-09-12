import type { ProberRunSummary } from './types';

/** Clean, plain-language security alert email for auth regressions. */
export function buildProberAlertEmail(input: {
  projectUrl: string;
  findings: Array<{
    path: string;
    severity: string;
    baselineStatus: number;
    actualStatus: number;
    variant?: string | null;
    keyFingerprint?: string | null;
  }>;
}): { subject: string; text: string } {
  const allAnon = input.findings.length > 0 && input.findings.every((f) => f.variant === 'anon_role');
  const hasAnon = input.findings.some((f) => f.variant === 'anon_role');

  const lines = input.findings.map((f) => {
    if (f.variant === 'anon_role') {
      const fpSuffix = f.keyFingerprint ? ` [key: ${f.keyFingerprint}]` : '';
      return `• ${f.path} — previously responded with ${f.baselineStatus} (protected), now opens with the public anon key (Supabase RLS/anon-role exposure) returning ${f.actualStatus} OK (${f.severity})${fpSuffix}`;
    }
    return `• ${f.path} — previously responded with ${f.baselineStatus} (protected), now responds with ${f.actualStatus} OK without login (${f.severity})`;
  });

  const subject = allAnon
    ? `🚨 Auth regression on ${input.projectUrl} — ${input.findings.length} endpoint(s) open with public anon key (Supabase RLS/anon-role exposure)`
    : hasAnon
    ? `🚨 Auth regression on ${input.projectUrl} — ${input.findings.length} page(s) exposed (including Supabase anon-role)`
    : `🚨 Auth regression on ${input.projectUrl} — ${input.findings.length} page(s) stopped requiring login`;

  return {
    subject,
    text: [
      `ScanlyFix Auth Prober detected a security regression on ${input.projectUrl}:`,
      '',
      ...lines,
      '',
      'View details and manage findings in your dashboard: Runtime → Auth Prober',
    ].join('\n'),
  };
}

export function summarizeRun(s: ProberRunSummary): string {
  return `baseline:${s.baselinesRecorded} checked:${s.checked} new:${s.newFindings} resolved:${s.autoResolved} open:${s.stillOpen} err:${s.errors}`;
}