/**
 * The per-repository report: what a repo scan found, who asked for it, and
 * what to do about it.
 *
 * Deliberately read-mostly. Nothing on this page runs a scan by itself —
 * scanning happens ONLY when someone presses the Scan button (which posts to
 * /api/repos/scan) or an automation enqueues one. Every other visit renders
 * the previous scan from the database: `repo_scans` for the numbers,
 * `repo_findings` for the detail. That is the contract the user asked for and
 * the reason the empty state says "not scanned yet" instead of scanning.
 *
 * Access control is per-repo, the same rule the scan endpoint enforces:
 * getRepoForViewer returns null for a repo whose installation belongs to
 * someone else, and getRepoScanForViewer refuses scans the viewer does not
 * own — so guessing a repo id or a scan id cannot read another account's
 * findings.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { REPO_CATEGORY_ORDER, type RepoCategory, type RepoScanScores } from '@scanlyfix/repo-checks'
import {
  getRepoForViewer,
  getRepoScanForViewer,
  listRepoScansForRepo,
  type GithubRepo,
  type RepoFindingRow,
  type RepoScan,
  type RepoScanWithFindings,
} from '@scanlyfix/db'
import type { Severity } from '@scanlyfix/checks'
import { getViewer, requireUser } from '@/lib/authz.ts'
import { PageHeader } from '@/components/console/page-header.tsx'
import { PageMotion } from '@/components/console/motion.tsx'
import { Icon } from '@/components/console/icons.tsx'
import { RepoScanButton } from '@/components/console/repo-scan-button.tsx'
import { RepoScanPoller } from './repo-scan-poller.tsx'

export const metadata: Metadata = { title: 'Repository report' }

/** Postgres rejects a malformed uuid with an error, so filter before querying. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REPO_CATEGORY_LABEL: Record<RepoCategory, string> = {
  secrets: 'Secrets',
  'supply-chain': 'Supply chain',
  'ci-cd': 'CI/CD',
  'code-quality': 'Code quality',
  dependencies: 'Dependencies',
  governance: 'Governance',
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info']

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: 'text-sev-critical',
  high: 'text-sev-high',
  medium: 'text-sev-medium',
  low: 'text-sev-low',
  info: 'text-sev-info',
}

function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function scoreTone(score: number): string {
  if (score >= 90) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 70) return 'text-amber-600 dark:text-amber-400'
  return 'text-sev-high'
}

function barTone(score: number): string {
  if (score >= 90) return 'bg-emerald-500'
  if (score >= 70) return 'bg-amber-500'
  return 'bg-sev-high'
}

export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ repoId: string }>
  searchParams: Promise<{ scan?: string }>
}) {
  const { repoId } = await params
  const { scan: scanParam } = await searchParams

  await requireUser(`/repos/${repoId}`)
  const viewer = await getViewer()

  const repo = await getRepoForViewer(repoId, viewer)
  if (!repo) notFound()

  const scans = await listRepoScansForRepo(repo.id, 12)

  /*
   * Which scan to show: the one the URL names (history rows link there), or
   * the latest finished one when nothing is selected. A selected scan that
   * belongs to a DIFFERENT repo is ignored — the URL is a query string, so
   * it is attacker-controlled, and the header above it must always describe
   * the repo the path names.
   */
  const selectedId = typeof scanParam === 'string' && UUID.test(scanParam) ? scanParam : null
  let report: RepoScanWithFindings | null = null
  if (selectedId) {
    const picked = await getRepoScanForViewer(selectedId, viewer)
    if (picked && picked.repoId === repo.id) report = picked
  } else {
    const latestDone = scans.find((s) => s.status === 'done')
    report = latestDone ? await getRepoScanForViewer(latestDone.id, viewer) : null
  }

  const latest = scans[0] ?? null
  const active = latest !== null && (latest.status === 'queued' || latest.status === 'running')

  return (
    <div className="console flex min-h-dvh flex-col bg-c-bg text-c-ink">
      <PageHeader
        title={repo.fullName}
        actions={
          <Link
            href="/feed#repositories"
            data-press=""
            className="rounded-full bg-c-soft px-4 py-1.5 text-[12px] font-medium text-c-muted transition-colors hover:bg-c-line hover:text-c-ink"
          >
            All repositories
          </Link>
        }
      />

      <div
        data-motion-scope="repos"
        className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10 sm:py-10"
      >
        <PageMotion scope="repos" />

        {/* Repo identity + the only thing on this page that starts work */}
        <section className="console-enter rounded-xl border border-c-line/60 bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="flex flex-wrap items-center gap-4 px-6 py-5 sm:px-8">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-c-soft text-c-muted">
              <Icon name="repo" size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[17px] font-medium text-c-ink">{repo.fullName}</p>
              <p className="truncate text-[13px] text-c-muted">
                {repo.private ? 'Private' : 'Public'} · default branch{' '}
                <span className="font-mono">{repo.defaultBranch}</span>
              </p>
            </div>
            <RepoScanButton repoId={repo.id} />
          </div>
        </section>

        {active && <RepoScanPoller active />}

        {latest?.status === 'queued' || latest?.status === 'running' ? (
          <section className="rounded-xl border border-c-line/60 bg-c-card p-8 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <p className="text-[16px] font-medium text-c-ink">
              {STATUS_LABEL[latest.status]} — scanning {repo.fullName}
            </p>
            <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-c-muted">
              The previous report stays below until the new scan finishes; this
              page updates by itself.
            </p>
          </section>
        ) : null}

        {report ? (
          <Report report={report} />
        ) : latest?.status === 'failed' ? (
          <FailedScan latest={latest} repo={repo} />
        ) : (
          <EmptyState repo={repo} />
        )}

        {/* Scan history — every row links to the report of that scan */}
        {scans.length > 1 && (
          <section data-reveal="">
            <h2 data-reveal-item="" className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-c-muted">
              Scan history
            </h2>
            <ul className="rounded-xl border border-c-line/60 bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              {scans.map((scan, index) => {
                const inner = (
                  <div className="flex items-center gap-4 px-6 py-4">
                    <StatusDot status={scan.status} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium text-c-ink">
                        {STATUS_LABEL[scan.status] ?? scan.status}
                        <span className="ml-2 text-[12px] font-normal text-c-muted">
                          {scan.profile}
                        </span>
                      </p>
                      <p className="console-num text-[12px] text-c-muted">{stamp(scan.createdAt)}</p>
                    </div>
                    <p className={`console-num text-[18px] font-light tracking-tight ${scan.scores?.overall != null ? scoreTone(scan.scores.overall) : 'text-c-muted'}`}>
                      {scan.scores?.overall ?? '—'}
                    </p>
                  </div>
                )
                return scan.status === 'done' ? (
                  <li
                    key={scan.id}
                    data-reveal-item=""
                    className={`group ${index === 0 ? '' : 'border-t border-c-line/60'}`}
                  >
                    <Link href={`/repos/${repo.id}?scan=${scan.id}`} className="block transition-colors hover:bg-c-soft/60">
                      {inner}
                    </Link>
                  </li>
                ) : (
                  <li
                    key={scan.id}
                    data-reveal-item=""
                    className={`${index === 0 ? '' : 'border-t border-c-line/60'}`}
                  >
                    {inner}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

function Report({ report }: { report: RepoScanWithFindings }) {
  const scores = report.scores
  const findings = report.findings

  return (
    <>
      <section data-reveal="">
        <h2 data-reveal-item="" className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-c-muted">
          Latest report
        </h2>
        <div
          data-reveal-item=""
          className="rounded-xl border border-c-line/60 bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        >
          <div className="grid gap-8 px-6 py-7 sm:px-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-12">
            {scores ? (
              <div className="flex items-center gap-5">
                <div className="text-center">
                  <p
                    data-count={String(scores.overall)}
                    className={`console-num text-5xl font-light tracking-tight ${scoreTone(scores.overall)}`}
                  >
                    {scores.overall}
                  </p>
                  <p className="mt-1 text-[12px] text-c-muted">overall</p>
                </div>
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              {scores ? (
                <PillarBars scores={scores} />
              ) : (
                <p className="text-[14px] text-c-muted">This scan completed without a score.</p>
              )}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 border-t border-c-line px-6 py-5 text-[13px] sm:grid-cols-3 sm:px-8">
            <Fact label="Profile" value={report.profile} />
            <Fact label="Checks run" value={String(report.checksRun)} />
            <Fact label="Duration" value={report.durationMs === null ? '—' : `${report.durationMs} ms`} />
            <Fact label="Scanned" value={stamp(report.createdAt)} />
            <Fact label="Engine" value={report.engineVersion} />
            <Fact label="Findings" value={String(findings.length)} />
          </dl>
        </div>
      </section>

      {report.checkErrors.length > 0 && (
        <CheckErrors errors={report.checkErrors} />
      )}

      <FindingsList findings={findings} />
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-c-muted">{label}</dt>
      <dd className="min-w-0 truncate text-c-ink">{value}</dd>
    </div>
  )
}

function PillarBars({ scores }: { scores: RepoScanScores }) {
  return (
    <ul className="flex flex-col gap-3.5">
      {REPO_CATEGORY_ORDER.map((category) => {
        const value = scores[category]
        const degraded = scores.degraded.includes(category)
        return (
          <li key={category} className="flex items-center gap-4">
            <span className="w-32 shrink-0 text-[13px] text-c-body">
              {REPO_CATEGORY_LABEL[category]}
              {degraded && <span className="ml-1 text-[11px] text-amber-500" title="A check in this pillar could not complete; the score is provisional">~</span>}
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-c-soft">
              <span className={`block h-full rounded-full ${barTone(value)}`} style={{ width: `${value}%` }} />
            </span>
            <span className="console-num w-8 shrink-0 text-right text-[13px] font-medium text-c-ink">
              {value}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === 'done'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-sev-high'
        : status === 'running'
          ? 'bg-c-accent'
          : 'bg-c-line'
  return <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone}`} />
}

/** Our failures, shown rather than hidden behind a score that looks complete. */
function CheckErrors({ errors }: { errors: Array<{ checkId: string; message: string }> }) {
  return (
    <section className="rounded-xl border border-c-line/60 bg-c-card px-6 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <h2 className="text-[14px] font-medium text-c-ink">
        {errors.length} check{errors.length === 1 ? '' : 's'} could not complete
      </h2>
      <p className="mt-1 text-[13px] text-c-muted">
        The pillars they belong to are marked provisional above. This is a
        problem on our side, not with the repository.
      </p>
      <ul className="mt-3 flex flex-col gap-1 font-mono text-[12px] text-c-muted">
        {errors.map((e) => (
          <li key={e.checkId}>
            {e.checkId} — {e.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

function FindingsList({ findings }: { findings: RepoFindingRow[] }) {
  if (findings.length === 0) {
    return (
      <section className="rounded-xl border border-c-line/60 bg-c-card p-10 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-500">
          <Icon name="shield" size={22} />
        </span>
        <p className="mt-4 text-[15px] font-medium text-c-ink">No findings</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-c-muted">
          This scan found nothing to report across secrets, supply chain, CI/CD,
          dependencies and governance. The good outcome — scan again after a
          change to keep it that way.
        </p>
      </section>
    )
  }

  const bySeverity = SEVERITIES.map((severity) => ({
    severity,
    rows: findings.filter((f) => f.severity === severity),
  })).filter((g) => g.rows.length > 0)

  return (
    <section data-reveal="">
      <h2 data-reveal-item="" className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-c-muted">
        Findings
      </h2>
      <ul className="flex flex-col gap-4">
        {bySeverity.map((group) =>
          group.rows.map((finding) => <FindingCard key={finding.id} finding={finding} />),
        )}
      </ul>
    </section>
  )
}

function FindingCard({ finding }: { finding: RepoFindingRow }) {
  return (
    <li data-reveal-item="" className="overflow-hidden rounded-xl border border-c-line/60 bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="border-l-2 border-sev-critical px-6 py-5 sm:px-8">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.06em]">
          <span className={SEVERITY_TEXT[finding.severity]}>{finding.severity}</span>
          <span aria-hidden="true" className="text-c-line">·</span>
          <span className="font-normal normal-case tracking-normal text-c-muted">
            {REPO_CATEGORY_LABEL[finding.category]}
          </span>
          <span className="ml-auto font-mono text-[10px] normal-case tracking-normal text-c-muted">
            {finding.checkId}
          </span>
        </p>
        <h3 className="mt-2 text-[15px] font-medium leading-snug text-pretty text-c-ink">
          {finding.title}
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-c-body">{finding.description}</p>

        {finding.evidence && Object.keys(finding.evidence).length > 0 && (
          <pre className="mt-3 overflow-x-auto rounded-lg border border-c-line/60 bg-c-bg px-4 py-3 font-mono text-[12px] leading-relaxed text-c-ink">
            {JSON.stringify(finding.evidence, null, 2)}
          </pre>
        )}

        <div className="mt-4 rounded-lg border border-c-line/60 bg-c-soft/50 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-c-muted">
            Remediation
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-c-ink">{finding.remediation}</p>
        </div>

        {finding.fixPrompt && (
          <details className="group mt-3">
            <summary className="cursor-pointer select-none text-[12px] font-medium text-c-muted transition-colors hover:text-c-ink">
              Fix prompt for an AI coding agent
            </summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-c-line/60 bg-c-bg px-4 py-3 font-mono text-[12px] leading-relaxed text-c-ink">
              {finding.fixPrompt}
            </pre>
          </details>
        )}
      </div>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* Empty / failed states                                                      */
/* -------------------------------------------------------------------------- */

function EmptyState({ repo }: { repo: GithubRepo }) {
  return (
    <section className="rounded-xl border border-c-line/60 bg-c-card p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-c-soft text-c-muted">
        <Icon name="search" size={24} />
      </span>
      <p className="mt-5 text-[16px] font-medium text-c-ink">Not scanned yet</p>
      <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-c-muted text-pretty">
        Press <span className="text-c-ink">Scan</span> above to run the
        github-scanner against {repo.fullName} — it checks for leaked secrets,
        vulnerable dependencies, and workflow misconfigurations. The report
        lands here, and the previous one stays until a new scan finishes.
      </p>
    </section>
  )
}

function FailedScan({ latest, repo }: { latest: RepoScan; repo: GithubRepo }) {
  return (
    <section className="rounded-xl border border-red-300/60 bg-red-50 px-6 py-8 text-center dark:border-red-500/30 dark:bg-red-950/30">
      <p className="text-[16px] font-medium text-red-800 dark:text-red-300">
        The last scan of {repo.fullName} failed
      </p>
      <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-red-700/80 dark:text-red-300/80">
        {latest.error ?? 'The scan stopped without a reason. Try again in a moment.'}
      </p>
    </section>
  )
}