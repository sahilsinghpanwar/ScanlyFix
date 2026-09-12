/**
 * Every function the serve handler exposes.
 *
 * A function missing from this list is registered nowhere and runs never —
 * silently, with no error and nothing in a log to notice. One file, so the
 * question "is this job live?" has one place to answer it.
 */

import { sweepMonitors } from './functions/sweep.ts'
import { uptimeProbe } from './functions/uptime-probe.ts'
import { rescanProject } from './functions/scheduled-rescan.ts'
import { domainProbe } from './functions/domain-probe.ts'
import { runScanQueued } from './functions/run-scan.ts'
import { generateReport } from './functions/generate-report.ts'
import { runRepoScanQueued } from './functions/run-repo-scan.ts'
import { webVitalsProbe } from './functions/web-vitals-probe.ts'
import { rollupWorker } from './functions/rollup-worker.ts'
import { autoResolveStaleIncidents } from './functions/auto-resolve-stale-incidents.ts'
import { runtimeAuthProber, runtimeAuthProberProject } from './functions/runtime-auth-prober.ts'
import { runtimeSpendWatch } from './functions/runtime-spend-watch.ts'
import { runtimePricingSync } from './functions/runtime-pricing-sync.ts'

export const functions = [
  sweepMonitors,
  uptimeProbe,
  rescanProject,
  domainProbe,
  runScanQueued,
  runRepoScanQueued,
  generateReport,
  webVitalsProbe,
  rollupWorker,
  autoResolveStaleIncidents,
  runtimeAuthProber,
  runtimeAuthProberProject,
  runtimeSpendWatch,
  runtimePricingSync,
]
