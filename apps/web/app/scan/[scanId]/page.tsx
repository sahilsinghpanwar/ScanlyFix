/**
 * The report. The page the whole product exists to produce, and the one that
 * gets pasted into other people's Slack channels.
 *
 * Server-rendered end to end: nothing here needs state except the copy button,
 * which is its own client component. Read through getScanForViewer with an
 * anonymous viewer — an anonymous scan is public by design, and a scan that
 * belongs to a project comes back null and renders as not found, which is the
 * correct answer to "does this exist" from someone not entitled to know.
 */

import { cache } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { buildFixPrompt } from '@scanlyfix/checks'
import { getScanForViewer, type ScanWithFindings, type Viewer } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { claimScanAction } from './actions.ts'
import { ScoreRing } from '@/components/scan/score-ring.tsx'
import { LogoBadge } from '@/components/brand/logo.tsx'
import { LabeledRule } from '@/components/ui/labeled-rule.tsx'
import { PillarScores } from '@/components/scan/pillar-scores.tsx'
import { FindingsList } from '@/components/scan/findings-list.tsx'
import { FixPromptDialog } from '@/components/scan/fix-prompt-dialog.tsx'
import { ExportLinks } from '@/components/scan/export-links.tsx'
import { ReportGate } from '@/components/scan/report-gate.tsx'
import { ScanProgress } from '@/components/scan/scan-progress.tsx'
import { entitlementsFor, type Entitlements } from '@/lib/entitlements.ts'
import { canSeeFixPrompt, redactFindings } from '@/lib/redact.ts'
import type { FindingView } from '@/components/scan/finding-card.tsx'

/** Postgres rejects a malformed uuid with an error, so filter before querying. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shared between generateMetadata and the page so one render is one query.
 *
 * The REAL viewer is passed, not a hardcoded anonymous one. An anonymous scan
 * comes back for anybody either way — that is the shareable report — but a scan
 * that belongs to a project must come back for its owner, who reaches it from
 * their own history. Hardcoding anonymous here would 404 people on their own
 * scans.
 */
const loadScan = cache(async (scanId: string, viewer: Viewer) => {
  if (!UUID.test(scanId)) return null
  return getScanForViewer(scanId, viewer)
})

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** UTC rather than a locale format: this URL is shared across time zones. */
function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ scanId: string }>
}): Promise<Metadata> {
  const { scanId } = await params
  const scan = await loadScan(scanId, await getViewer())
  if (!scan) return { title: 'Scan not found' }

  const host = hostOf(scan.url)
  const score = scan.scores?.overall
  return {
    title: score === undefined ? `Scan of ${host}` : `${host} scored ${score}/100`,
    description:
      scan.status === 'done'
        ? `Security and SEO findings for ${host}, measured by ScanlyFix.`
        : `ScanlyFix could not complete a scan of ${host}.`,
  }
}

export default async function ScanPage({ params }: { params: Promise<{ scanId: string }> }) {
  const { scanId } = await params
  const viewer = await getViewer()
  const scan = await loadScan(scanId, viewer)
  if (!scan) notFound()

  const host = hostOf(scan.url)
  const claimable = scan.projectId === null && scan.requestedBy === null

  // Redaction happens here, above every component. Nothing below this line
  // receives the withheld text, so no component can leak it by accident.
  const entitlements = await entitlementsFor(viewer)
  const report = redactFindings(scan.findings, entitlements)

  // A signed-in reader goes back into the app; a stranger who followed a
  // shared link goes to the landing page, where scanning still starts. This
  // report is shareable and server-rendered, so both cases land here — the
  // difference is only where each is sent next.
  const home = viewer.kind === 'user' ? '/dashboard' : '/'

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <div className="flex items-center justify-between gap-4">
          <Link href={home} className="flex items-center gap-2.5" aria-label="ScanlyFix — home">
            <LogoBadge size={34} />
            <span className="text-xl font-semibold tracking-tight">scanlyfix</span>
          </Link>
          <Link
            href={home}
            className="link text-sm font-medium text-muted transition-colors hover:text-ink"
          >
            Scan another site
          </Link>
        </div>

        <div className="mt-8">
          <LabeledRule label="Report" trailing={stamp(scan.createdAt)} />
        </div>
        <h1 className="mt-5 truncate text-3xl tracking-[-0.02em] sm:text-4xl">{host}</h1>
      </header>

      {scan.status === 'failed' && <FailedScan url={scan.url} error={scan.error} at={scan.createdAt} />}

      {(scan.status === 'queued' || scan.status === 'running') && <RunningScan scanId={scan.id} />}

      {scan.status === 'done' && scan.scores && (
        <>
          <section className="flex flex-col items-center gap-8 py-8 sm:flex-row sm:items-center">
            <ScoreRing score={scan.scores.overall} size={190} />
            <div className="w-full flex-1">
              <PillarScores scores={scan.scores} />
            </div>
          </section>

          <ScanFacts
            finalUrl={scan.contextMeta?.finalUrl ?? scan.url}
            status={scan.contextMeta?.status ?? null}
            redirects={scan.contextMeta?.redirectChain.length ?? 0}
            checksRun={scan.checksRun}
            engineVersion={scan.engineVersion}
            durationMs={scan.durationMs}
            at={scan.createdAt}
          />

          {scan.checkErrors.length > 0 && <CheckErrors errors={scan.checkErrors} />}

          {/* Only for a signed-in reader. A signed-out one already has one
              sign-in ask on this page — the gate below — and two competing
              calls to action is how neither gets taken. */}
          {claimable && entitlements.signedIn && <SaveReport scanId={scan.id} host={host} />}

          <AggregateFixPrompt scan={scan} entitlements={entitlements} />

          {/* Shown only to a plan that has it. A download button that answers
              403 is a worse discovery of the paywall than not offering one. */}
          {entitlements.plan.exports && <ExportLinks scanId={scan.id} />}

          {/* Only when an answer is actually filtering the view. A reader who
              never chose sees everything already, and offering to change a
              preference they have not set is a question, not a control. */}
          {entitlements.priorities !== null && entitlements.priorities.length > 0 && (
            <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border border-line bg-surface px-5 py-4">
              <p className="text-[15px] text-muted text-pretty">
                This report opens with the pillars you picked.
              </p>
              <Link
                href={`/welcome?next=/scan/${scan.id}`}
                className="label inline-flex h-10 shrink-0 items-center border border-ink px-5 text-ink
                           transition-colors duration-150 hover:bg-ink hover:text-canvas"
              >
                Change priorities
              </Link>
            </div>
          )}

          <div className="mt-10">
            <FindingsList
              findings={report.findings as FindingView[]}
              priorities={entitlements.priorities}
              scanId={scan.id}
              lockedNote={
                entitlements.signedIn
                  ? 'The detail and the fix for this finding are part of Pro.'
                  : 'Sign in to open this finding — the evidence behind it and the fix.'
              }
            />
          </div>

          <ReportGate
            lockedCount={report.lockedCount}
            lockedSeverities={report.lockedSeverities}
            signedIn={entitlements.signedIn}
            returnTo={`/scan/${scan.id}`}
          />
        </>
      )}
    </div>
  )
}

/**
 * A refused or unreachable target is a legitimate outcome, not an error page.
 * The visitor is told what was attempted and what came back, because "Refusing
 * to scan a private address" is information, and a generic failure screen
 * throws it away.
 */
function FailedScan({ url, error, at }: { url: string; error: string | null; at: Date }) {
  return (
    <section className="my-10 border border-line bg-surface p-6">
      <h2 className="text-lg font-semibold">This scan could not be completed</h2>
      <p className="mt-2 text-sm text-muted">
        ScanlyFix tried to read <code className="font-mono">{url}</code> at {stamp(at)} and stopped.
      </p>
      {error && (
        <p className="mt-3 border border-line bg-canvas px-3 py-2 font-mono text-sm">{error}</p>
      )}
      <p className="mt-4 text-sm text-muted">
        If the address was a typo, correct it and try again. If the site is behind a login or blocks
        automated requests, ScanlyFix cannot read it — it only ever reads what a browser would.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm link">
        Try another address
      </Link>
    </section>
  )
}

/**
 * Unreachable while scans run inline. It is written now because Phase 5 moves
 * them onto a queue, and the branch that is missing on the day you need it
 * costs an afternoon.
 */
function RunningScan({ scanId }: { scanId: string }) {
  return (
    <section className="my-10 border border-line bg-surface p-6">
      <h2 className="text-lg font-semibold">Still scanning</h2>
      <ScanProgress scanId={scanId} />
    </section>
  )
}

function ScanFacts({
  finalUrl,
  status,
  redirects,
  checksRun,
  engineVersion,
  durationMs,
  at,
}: {
  finalUrl: string
  status: number | null
  redirects: number
  checksRun: number
  engineVersion: string
  durationMs: number | null
  at: Date
}) {
  const facts: Array<[string, string]> = [
    ['Final URL', finalUrl],
    ['HTTP', status === null ? '—' : String(status)],
    ['Redirects', String(redirects)],
    ['Checks run', String(checksRun)],
    ['Duration', durationMs === null ? '—' : `${durationMs} ms`],
    ['Scanned', stamp(at)],
    // Recorded on the page, not just in the row: two reports of the same site
    // are only comparable when this matches, and a reader cannot know that
    // unless it is visible.
    ['Engine', engineVersion],
  ]

  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-3 border-t border-line pt-5 sm:grid-cols-2">
      {facts.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-3">
          <dt className="w-28 shrink-0 font-mono text-xs uppercase tracking-[0.12em] text-muted">{key}</dt>
          <dd className="min-w-0 truncate text-[15px] leading-6">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Our failures, shown rather than hidden behind a score that looks complete. */
function CheckErrors({ errors }: { errors: Array<{ checkId: string; message: string }> }) {
  return (
    <section className="mt-6 border border-line px-4 py-3">
      <h2 className="text-sm font-medium">
        {errors.length} check{errors.length === 1 ? '' : 's'} could not complete
      </h2>
      <p className="mt-1 text-sm text-muted">
        The pillars they belong to are marked provisional above. This is a problem on our side, not
        with the site.
      </p>
      <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-muted">
        {errors.map((e) => (
          <li key={e.checkId}>
            {e.checkId} — {e.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The conversion moment, placed directly under the score where the reader has
 * just seen something worth keeping.
 *
 * Signed-in readers only — the signed-out branch was removed when the report
 * gate below took over that ask. Two sign-in prompts on one page is how
 * neither gets taken.
 */
function SaveReport({ scanId, host }: { scanId: string; host: string }) {
  return (
    <section className="mt-6 flex flex-wrap items-center justify-between gap-3 border border-line bg-surface px-5 py-4">
      <div>
        <p className="text-sm font-medium">Keep this report</p>
        <p className="text-sm text-muted">
          Track {host} over time and see what changes between scans.
        </p>
      </div>

      <form action={claimScanAction}>
        <input type="hidden" name="scanId" value={scanId} />
        <button
          type="submit"
          className="label inline-flex h-11 items-center border border-ink bg-ink px-6 text-canvas
                     transition-colors duration-150 hover:bg-transparent hover:text-ink"
        >
          Save as a project
        </button>
      </form>
    </section>
  )
}

/**
 * Built on read rather than stored, so a report gets today's prompt: the
 * grouping and the stack-specific locations improve as the engine does, and a
 * prompt frozen at scan time would keep handing out last month's advice.
 */
function AggregateFixPrompt({
  scan,
  entitlements,
}: {
  scan: ScanWithFindings
  entitlements: Entitlements
}) {
  // Withheld whole rather than truncated: an agent handed half a work order
  // makes half the changes and reports success.
  if (!canSeeFixPrompt(entitlements)) return null

  const prompt = buildFixPrompt(scan.findings, {
    url: scan.contextMeta?.finalUrl ?? scan.url,
    stack: {
      framework: scan.contextMeta?.framework ?? null,
      // Absent on scans recorded before platform detection existed; null is the
      // honest value there, and the prompt falls back to generic guidance.
      platform: scan.contextMeta?.platform ?? null,
    },
  })

  // Empty when nothing is actionable — a report of only informational rows has
  // no work order, and an empty box would imply otherwise.
  if (!prompt) return null

  const actionable = scan.findings.filter((f) => f.severity !== 'info').length
  return <FixPromptDialog prompt={prompt} issueCount={actionable} />
}
