/**
 * Which face the dashboard's latest-report section should show.
 *
 * Pure on purpose: the decision is the section's whole behaviour, so it is
 * testable without rendering, and the component cannot drift from the tests.
 */

export type LatestReportView = 'hidden' | 'loading' | 'failed' | 'done'

/**
 * 'hidden'  nothing scanned yet — the section does not exist on the page.
 * 'loading' the workers are running the scan; show the loader and keep polling.
 * 'failed'  the scan refused or could not finish; show why.
 * 'done'    show the report. A done scan with no score row still counts as
 *           done — the score block just renders empty, and the findings decide
 *           what the reader sees.
 */
export function latestReportView(scan: { status: string } | null): LatestReportView {
  if (!scan) return 'hidden'
  if (scan.status === 'queued' || scan.status === 'running') return 'loading'
  if (scan.status === 'failed') return 'failed'
  return 'done'
}
