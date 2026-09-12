import type { CanaryDetection } from './types';

const KIND_TEXT: Record<string, string> = {
  modified: 'Decoy row was MODIFIED',
  deleted: 'Decoy row was DELETED',
  anon_readable: 'Canary table is READABLE with the anon (public) key — RLS hole',
  log_wiped: 'Canary trigger log was WIPED — tamper evidence',
  honeytoken_hit: '🍯 Honeytoken hit — leaked data is being USED',
  table_missing: 'Canary table is missing — setup was reverted or removed',
};

export function buildCanaryAlertEmail(input: {
  hostname: string;
  detections: CanaryDetection[];
}): { subject: string; text: string } {
  const lines = input.detections.map(
    (d) => `• [${d.kind}] ${KIND_TEXT[d.kind] ?? d.kind} — ${d.detail}`,
  );
  return {
    subject: `🚨 Database canary triggered on ${input.hostname} — someone reached a place they should never have touched`,
    text: [
      `ScanlyFix canaries detected activity in the database of ${input.hostname}.`,
      'These rows are decoys — no legitimate code path, user, or cron job ever touches them.',
      'That means access happened (a leak, a mistake, or a breach). No triage needed — this is a fact, not a hypothesis.',
      '',
      ...lines,
      '',
      'Dashboard: Runtime → Canaries — events timeline and anon-access audit are there.',
    ].join('\n'),
  };
}