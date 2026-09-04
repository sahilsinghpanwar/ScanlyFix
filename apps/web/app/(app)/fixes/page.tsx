/**
 * AutoFix — every issue from the user's scans, each with its Fix button.
 *
 * The same fix as the report page's Fix button, deliberately: one backend
 * route (/api/fix), one master prompt, one model. The difference is scope —
 * the report shows one scan's findings; this page gathers the latest ad-hoc
 * scans and every tracked domain's most recent scan into one work queue, so
 * "what do I fix next" has one answer.
 *
 * Server-rendered: the list is a query, not state. Locked findings render as
 * locked rows here exactly as everywhere else — the paywall is decided by
 * redaction at read time, and this page does not get to reopen it.
 */

import Link from 'next/link'
import type { Severity } from '@scanlyfix/checks'
import {
  getScanForViewer,
  listProjectSummaries,
  listRecentScansForUser,
  type ScanWithFindings,
} from '@scanlyfix/db'
import { getViewer, requireUser } from '@/lib/authz.ts'
import { entitlementsFor } from '@/lib/entitlements.ts'
import { redactFindings, type PublicFinding } from '@/lib/redact.ts'
import { FixButton } from '@/components/scan/fix-button.tsx'
import { Icon } from '@/components/console/icons.tsx'

export const metadata = { title: 'AutoFix' }

/** How many scans are opened up. Bound the query count: 12 reports, not the account's history. */
const AD_HOC_SCANS = 8
const MAX_TOTAL_SCANS = 12

interface IssueRow {
  finding: PublicFinding
  scanId: string
  host: string
}

interface ScanGroup {
  scanId: string
  host: string
  scannedAt: string
  rows: IssueRow[]
}

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

const SEVERITY_CHIP: Record<Severity, string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
  info: 'bg-sev-info',
}

export default async function FixesPage() {
  const user = await requireUser('/fixes')
  const viewer = await getViewer()

  const [recent, projects] = await Promise.all([
    listRecentScansForUser(viewer, AD_HOC_SCANS),
    listProjectSummaries(viewer),
  ])

  // One entry per scan — ad-hoc scans and each domain's latest. Deduped, in
  // the order the rows will render: newest work first.
  const scanIds: string[] = []
  for (const id of [...recent.map((scan) => scan.id), ...projects.map((p) => p.latest?.id ?? null)]) {
    if (typeof id === 'string' && !scanIds.includes(id) && scanIds.length < MAX_TOTAL_SCANS) scanIds.push(id)
  }

  const scans = (await Promise.all(scanIds.map((id) => getScanForViewer(id, viewer)))).filter(
    (scan): scan is ScanWithFindings => scan !== null,
  )

  const entitlements = await entitlementsFor(viewer)
  const groups: ScanGroup[] = scans
    .map((scan) => ({
      scanId: scan.id,
      host: hostOf(scan.url),
      scannedAt: stamp(scan.createdAt),
      rows: redactFindings(scan.findings, entitlements).findings.map((finding) => ({
        finding,
        scanId: scan.id,
        host: hostOf(scan.url),
      })),
    }))
    .filter((group) => group.rows.length > 0)

  const openCount = groups.reduce((n, g) => n + g.rows.length, 0)

  return (
    <div className="console flex min-h-dvh flex-col bg-c-bg text-c-ink">
      <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-c-line/60 bg-c-bg/80 backdrop-blur-md px-6 sm:px-10">
        <div className="min-w-0 pl-12 lg:pl-0">
          <p className="truncate text-[15px] font-medium text-c-ink">AutoFix</p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-10 px-6 py-10 sm:px-10 sm:py-14">
        <section>
          <h1 className="text-[28px] font-light leading-tight tracking-[-0.02em] text-c-ink">
            Every issue. One prompt away from fixed.
          </h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-c-body">
            {openCount === 0
              ? 'Nothing to fix yet — scan a site and its findings land here.'
              : `${openCount} finding${openCount === 1 ? '' : 's'} across ${groups.length} scan${groups.length === 1 ? '' : 's'}. Press Fix on one and the model writes the exact prompt for your AI editor.`}
          </p>
        </section>

        {groups.length === 0 && (
          <section className="rounded-xl border border-c-line/60 bg-c-card p-12 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <p className="text-[16px] font-medium text-c-ink">No issues to fix yet</p>
            <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-c-muted text-pretty">
              Run a scan from the dashboard and every finding shows up here with its
              Fix button.
            </p>
            <Link
              href="/dashboard"
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-c-ink px-6 py-2.5 text-[13px] font-medium text-c-brand-ink transition-opacity hover:opacity-90"
            >
              <Icon name="home" size={14} />
              Go to dashboard
            </Link>
          </section>
        )}

        {groups.map((group) => (
          <section key={group.scanId}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[14px] font-medium text-c-ink">{group.host}</h2>
              <p className="text-[12px] text-c-muted">
                scanned {group.scannedAt} ·{' '}
                <Link href={`/scan/${group.scanId}`} className="hover:text-c-ink">
                  full report
                </Link>
              </p>
            </div>
            <ul className="overflow-hidden rounded-xl border border-c-line/60 bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              {group.rows.map((row, index) => (
                <li
                  key={`${row.finding.checkId}-${index}`}
                  className={index === 0 ? '' : 'border-t border-c-line/60'}
                >
                  <div className="flex flex-wrap items-center gap-3 px-6 py-4">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEVERITY_CHIP[row.finding.severity]}`}
                      title={row.finding.severity}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-c-ink">
                        {row.finding.title}
                      </span>
                      <span className="block truncate font-mono text-[12px] text-c-muted">
                        {row.finding.severity} · {row.finding.category} · {row.finding.checkId}
                      </span>
                    </span>
                    {row.finding.locked ? (
                      <span className="rounded-full bg-c-soft px-3 py-1 text-[12px] font-medium text-c-muted">
                        Part of Pro
                      </span>
                    ) : (
                      <FixButton scanId={row.scanId} checkId={row.finding.checkId} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
