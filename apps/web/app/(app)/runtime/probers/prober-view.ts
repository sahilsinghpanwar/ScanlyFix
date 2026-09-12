/**
 * Pure helper for prober UI — no server-side deps.
 */

/** Label for the "Record baseline" / "Refresh" button. */
export function recordBaselineButtonLabel(hasBaseline: boolean, targetCount: number): string {
  if (targetCount === 0) return 'Seed default routes & probe';
  if (!hasBaseline) return 'Record baseline';
  return 'Refresh baseline';
}
