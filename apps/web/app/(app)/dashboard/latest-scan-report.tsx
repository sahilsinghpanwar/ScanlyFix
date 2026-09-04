/**
 * The dashboard's live report section: the most recent ad-hoc scan, whatever
 * state it is in.
 *
 * Every scan started from the scan form runs in the background — the queue and
 * the scanner workers own the work, not this page. So the section has exactly
 * three faces: a loader while the workers are at it, a failure note when they
 * could not finish, and the report itself once they have. It always renders
 * the LATEST scan, so running a new scan is what swaps the content — the
 * section cannot go stale, because the page re-renders through the loader
 * every time.
 *
 * Server-rendered on purpose: the report markup is the same one /scan/[id]
 * renders (ScoreRing, PillarScores, FindingsList), so the dashboard and the
 * shareable report cannot drift. Polling is the one client island —
 * ScanProgress flips the server render to the report the moment the scan
 * lands, with no report JSON duplicated into a client fetch.
 */

import Link from 'next/link'
import type { ScanWithFindings, Viewer } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { entitlementsFor } from '@/lib/entitlements.ts'
import { redactFindings } from '@/lib/redact.ts'
import { ScoreRing } from '@/components/scan/score-ring.tsx'
import { PillarScores } from '@/components/scan/pillar-scores.tsx'
import { FindingsList } from '@/components/scan/findings-list.tsx'
import { ScanProgress } from '@/components/scan/scan-progress.tsx'
import { latestReportView } from '@/components/scan/latest-report-view.ts'
import type { FindingView } from '@/components/scan/finding-card.tsx'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export async function LatestScanReport({
  scan,
  viewer,
}: {
  scan: ScanWithFindings | null
  viewer: Viewer
}) {
  const view = latestReportView(scan)
  if (view === 'hidden' || !scan) return null

  const host = hostOf(scan.url)

  return (
    <section aria-label="Latest report">
      <div className="overflow-hidden rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <header className="flex items-center justify-between gap-4 border-b border-c-line px-6 py-4">
          <h2 className="text-sm font-medium text-c-ink">Latest report</h2>
          <Link
            href={`/scan/${scan.id}`}
            className="rounded-md border border-c-line bg-c-card px-3 py-1.5 text-[12px] font-medium text-c-ink
                       transition-colors hover:bg-c-soft"
          >
            Open full report
          </Link>
        </header>

        {view === 'loading' && <Loading host={host} scanId={scan.id} />}
        {view === 'failed' && <Failed host={host} error={scan.error} />}
        {view === 'done' && <Done scan={scan} viewer={viewer} />}
      </div>
    </section>
  )
}

/** The loader: the workers are running the scan, this page is just waiting. */
function Loading({ host, scanId }: { host: string; scanId: string }) {
  return (
    <div className="flex items-start gap-4 px-6 py-6">
      <span
        aria-hidden="true"
        className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-c-line border-t-c-ink"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-c-ink">Scanning {host}…</p>
        <p className="mt-1 text-[13px] leading-relaxed text-c-muted text-pretty">
          63 checks are running in the background across security, SEO, AI answers,
          performance, accessibility, and compliance. This section fills in by itself
          when the scan lands — no need to reload.
        </p>
        <ScanProgress scanId={scanId} />
      </div>
    </div>
  )
}

/** A refused or unreachable target: the outcome, and the way out. */
function Failed({ host, error }: { host: string; error: string | null }) {
  return (
    <div className="px-6 py-6">
      <p className="text-sm font-medium text-c-ink">
        The scan of {host} could not be completed
      </p>
      {error && (
        <p className="mt-2 break-words rounded-md border border-c-line bg-c-soft px-3 py-2 font-mono text-[13px] text-c-muted">
          {error}
        </p>
      )}
      <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-c-muted text-pretty">
        If the address was a typo, correct it and scan again. A site behind a login or
        one that blocks automated requests cannot be read.
      </p>
    </div>
  )
}

/** The report: score, pillars, and the findings behind them. */
async function Done({ scan, viewer }: { scan: ScanWithFindings; viewer: Viewer }) {
  const entitlements = await entitlementsFor(viewer)
  const report = redactFindings(scan.findings, entitlements)

  return (
    <div className="px-6 py-6">
      <div className="flex flex-col items-center gap-6 sm:flex-row">
        {scan.scores && (
          <>
            <ScoreRing score={scan.scores.overall} size={140} />
            <div className="w-full flex-1">
              <PillarScores scores={scan.scores} />
            </div>
          </>
        )}
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-2 border-t border-c-line pt-4 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-c-muted">Site</dt>
          <dd className="truncate font-mono text-c-ink">{hostOf(scan.url)}</dd>
        </div>
        <div>
          <dt className="text-c-muted">Checks run</dt>
          <dd className="console-num text-c-ink">{scan.checksRun}</dd>
        </div>
        <div>
          <dt className="text-c-muted">Findings</dt>
          <dd className="console-num text-c-ink">{scan.findings.length}</dd>
        </div>
        <div>
          <dt className="text-c-muted">Scanned</dt>
          <dd className="truncate font-mono text-c-ink">{stamp(scan.createdAt)}</dd>
        </div>
      </dl>

      {scan.findings.length > 0 ? (
        /*
         * One open/close with no state to share, so a <details> rather than a
         * client component: the browser supplies keyboard support and the
         * disclosure semantics, and the report ships no JavaScript for it.
         */
        <details className="mt-6 rounded-lg border border-c-line">
          <summary className="cursor-pointer px-5 py-4 transition-colors hover:bg-c-soft/60">
            <span className="text-sm font-medium text-c-ink">Detailed report</span>
            <span className="mt-0.5 block text-[13px] text-c-muted">
              Every finding with the evidence observed, the fix, and the prompt for your
              AI editor.
            </span>
          </summary>
          <div className="border-t border-c-line px-5 py-6">
            <FindingsList
              findings={report.findings as FindingView[]}
              priorities={entitlements.priorities}
              scanId={scan.id}
              lockedNote="The detail and the fix for this finding are part of Pro."
            />
          </div>
        </details>
      ) : (
        <p className="mt-6 border-t border-c-line pt-4 text-sm text-c-muted">
          Every check passed — nothing to fix was observed on this scan.
        </p>
      )}
    </div>
  )
}
