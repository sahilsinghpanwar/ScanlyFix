/**
 * The queue client.
 *
 * Arrives in Phase 5 rather than earlier because until now nothing needed it:
 * an inline scan finishes in about two seconds, and a queue would have been a
 * second failure domain bought for nothing. Cron is different — a job that must
 * run at 03:00 whether or not anyone is visiting cannot live in a request.
 */

import 'server-only'
import { Inngest } from 'inngest'

/**
 * Dev mode is inferred from NODE_ENV.
 *
 * Inngest dev server connects locally in development without cloud signing keys.
 * Production still enforces cloud signing keys when NODE_ENV === 'production'.
 */
const isDev = process.env.NODE_ENV !== 'production'

if (isDev && process.env.INNGEST_SIGNING_KEY?.startsWith('signkey-prod-')) {
  delete process.env.INNGEST_SIGNING_KEY
}

export const inngest = new Inngest({ id: 'scanlyfix', isDev })

/**
 * Event names, in one place. A typo in an event string is a job that silently
 * never runs — no error, no handler, nothing in a log to notice.
 */
export const EVENTS = {
  /** One per due monitor, emitted by the sweep. */
  monitorDue: 'scanlyfix/monitor.due',
  /**
   * A scan that has been reserved but not run. Emitted by the scan endpoint
   * for the deep profile, which cannot finish inside a request.
   */
  scanRequested: 'scanlyfix/scan.requested',
  /**
   * A report to build and deliver out of band. Emitted for the deliveries
   * nobody is waiting on — a scheduled digest, or a retry after the browser
   * tier was busy. The download route does not use it.
   */
  reportRequested: 'scanlyfix/report.requested',
  /**
   * A repo scan that has been reserved but not run. A repo scan always
   * queues (cloning a repo and running gitleaks/osv-scanner cannot finish
   * inside a request) so the same reserve/execute pattern as a deep site
   * scan applies, just on a different model.
   */
  repoScanRequested: 'scanlyfix/repo-scan.requested',
  /**
   * Per-project fan-out event for nightly auth prober.
   * Consumed by child worker with jitter and per-project concurrency limit.
   */
  authProberRunProject: 'runtime/auth-prober.run-project',
} as const
