/**
 * The console overview: what is wrong across every site this account watches.
 *
 * Redesigned to the Vercel console design system: a near-white canvas one step
 * below pure-white cards, hairline #eaeaea borders, cards that carry their own
 * header row inside a border-b, Geist body type with tabular figures for every
 * count, and one chromatic colour — the blue accent — reserved for active
 * meters and focus. Dark mode is class-driven (lib/theme.ts): the palette in
 * globals.css inverts through the same tokens, so nothing here branches on the
 * theme.
 */

import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  getDashboardSummary,
  getScanForViewer,
  listProjectSummaries,
  listRecentScansForUser,
  type DashboardFinding,
  type DashboardSummary,
  type ProjectSummary,
  type Scan,
} from '@scanlyfix/db'
import type { Category, Severity } from '@scanlyfix/checks'
import { getViewer, requireUser } from '@/lib/authz.ts'
import { ScanForm } from '@/components/scan/scan-form.tsx'
import { LatestScanReport } from './latest-scan-report.tsx'
import { NewProjectForm } from './new-project-form.tsx'
import { ThemeToggle } from '@/components/console/theme-toggle.tsx'
import { Icon } from '@/components/console/icons.tsx'

export const metadata = { title: 'Dashboard' }

const CHECKS_PER_SCAN = 63

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info']

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
}

const SEVERITY_BG: Record<Severity, string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
  info: 'bg-sev-info',
}

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: 'text-sev-critical',
  high: 'text-sev-high',
  medium: 'text-sev-medium',
  low: 'text-sev-low',
  info: 'text-sev-info',
}

const PILLARS: readonly { key: Category; label: string }[] = [
  { key: 'security', label: 'Security' },
  { key: 'seo', label: 'SEO' },
  { key: 'aeo', label: 'AI answers' },
  { key: 'performance', label: 'Performance' },
  { key: 'accessibility', label: 'Accessibility' },
  { key: 'compliance', label: 'Compliance' },
]

function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function scoreTone(score: number): string {
  if (score >= 90) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 70) return 'text-amber-600 dark:text-amber-400'
  return 'text-sev-high'
}

export default async function DashboardPage() {
  const user = await requireUser('/dashboard')

  /*
   * The one-question onboarding, enforced here and not only in /callback: a
   * session can reach the dashboard without passing through the callback —
   * a refresh, a bookmark, a client-side navigation — and priorities is null
   * only until it is answered once, so this cannot loop. The return trip is
   * the hidden `next` field on /welcome, which carries /dashboard back.
   */
  if (user.priorities === null) redirect('/welcome?next=%2Fdashboard')

  const viewer = await getViewer()
  const [summary, projects, recentScans] = await Promise.all([
    getDashboardSummary(viewer),
    listProjectSummaries(viewer),
    listRecentScansForUser(viewer),
  ])

  /*
   * The newest ad-hoc scan, loaded with its findings, is what the live report
   * section under the scan form renders — loader while it runs, report when it
   * lands. Every new scan replaces it, which is what makes the section move.
   */
  const latestScan = recentScans[0] ? await getScanForViewer(recentScans[0].id, viewer) : null

  const scores = [
    ...projects.map((p) => p.latest?.scores?.overall),
    ...recentScans.map((s) => s.scores?.overall),
  ].filter((n): n is number => typeof n === 'number')
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null

  return (
    <div className="console flex min-h-dvh flex-col bg-c-bg text-c-ink">
      <TopBar email={user.email} />

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">
        <ScanPanel />

        <LatestScanReport scan={latestScan} viewer={viewer} />

        <div className="grid gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <IssueSummary summary={summary} />
          <MonitoringPanel sites={projects.length} />
        </div>

        <NeedsAttention findings={summary.needsAttention} scanned={summary.sitesScanned} />

        <AssetSummary
          sites={projects.length}
          scans={recentScans.length}
          scanned={summary.sitesScanned}
          avg={avg}
        />

        <IssueTypes summary={summary} />

        <Sites projects={projects} orgId={user.orgId} />

        {recentScans.length > 0 && <RecentScans scans={recentScans} />}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

function TopBar({ email }: { email: string }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-c-line bg-c-bg/80 backdrop-blur-md px-4 sm:px-6">
      <h1 className="min-w-0 truncate pl-12 text-sm font-semibold text-c-ink lg:pl-1">
        Overview
      </h1>

      <div className="flex-1" />

      <ThemeToggle />

      <Link
        href="/pricing"
        className="hidden h-9 items-center gap-1.5 rounded-lg border border-c-line bg-c-card px-3.5
                   text-[13px] font-medium text-c-ink transition-colors hover:bg-c-soft sm:flex"
      >
        <Icon name="book" size={14} />
        Plans
      </Link>
      <Link
        href="/settings/billing"
        aria-label="Settings"
        className="grid h-9 w-9 place-items-center rounded-lg text-c-muted transition-colors hover:bg-c-soft hover:text-c-ink"
      >
        <Icon name="settings" />
      </Link>
      <span
        title={email}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-c-brand text-[13px] font-medium text-c-brand-ink"
      >
        {email.slice(0, 1).toUpperCase()}
      </span>
    </header>
  )
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The Vercel card: one border, one radius, and the header INSIDE the card,
 * divided from the body by the same hairline the page draws everywhere else.
 * An outer header above a bordered box needs two spacing decisions per card;
 * this pattern needs none, which is why every console card can share it.
 */
function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={`overflow-hidden rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-c-line px-6 py-4">
          {title && <h2 className="text-sm font-medium text-c-ink">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

/** The secondary action a card header gets: bordered, quiet, hover-lifted. */
function CardAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-c-line bg-c-card px-3 py-1.5 text-[12px] font-medium text-c-ink
                 transition-colors hover:bg-c-soft"
    >
      {children}
    </Link>
  )
}

/* -------------------------------------------------------------------------- */
/* Scan Panel                                                                 */
/* -------------------------------------------------------------------------- */

function ScanPanel() {
  return (
    <section className="rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="px-6 py-8 sm:px-8 sm:py-10">
        <h2 className="text-2xl font-semibold tracking-tight text-c-ink">
          Scan a site
        </h2>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-c-muted">
          {CHECKS_PER_SCAN} checks across security, SEO, AI answers, performance,
          accessibility, and compliance — each finding shows the evidence behind it.
        </p>

        <div className="mt-6 max-w-2xl">
          <ScanForm restore stayAfterStart tone="console" />
        </div>

        <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-c-muted">
          {PILLARS.map((pillar) => (
            <li key={pillar.key} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-c-line" />
              {pillar.label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Issue Summary                                                              */
/* -------------------------------------------------------------------------- */

function IssueSummary({ summary }: { summary: DashboardSummary }) {
  const { open, openTotal } = summary
  const present = SEVERITIES.filter((s) => open[s] > 0)

  return (
    <Card title="Issue summary">
      <div className="px-6 py-6">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-c-soft">
          {openTotal === 0 ? (
            <span className="h-full w-full bg-c-line" />
          ) : (
            present.map((severity) => (
              <span
                key={severity}
                className={`h-full ${SEVERITY_BG[severity]}`}
                style={{ width: `${(open[severity] / openTotal) * 100}%` }}
              />
            ))
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <p className="flex items-baseline gap-2.5">
            <span className="console-num text-3xl font-semibold leading-none tracking-tight text-c-ink">
              {openTotal}
            </span>
            <span className="text-[13px] text-c-muted">
              open {openTotal === 1 ? 'finding' : 'findings'}
            </span>
          </p>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {SEVERITIES.map((severity) => (
              <li key={severity} className="flex items-center gap-2 text-[13px]">
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 rounded-full ${SEVERITY_BG[severity]}`}
                />
                <span className="console-num font-medium text-c-ink">{open[severity]}</span>
                <span className="text-c-muted">{SEVERITY_LABEL[severity]}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-2 border-t border-c-line sm:grid-cols-4">
        <MiniStat icon="feed" label="Open" value={summary.openTotal} hint="awaiting a fix" />
        <MiniStat icon="shield" label="Fixed" value={summary.fixed} hint="confirmed gone" divider />
        <MiniStat icon="bell" label="Ignored" value={summary.ignored} hint="muted by you" divider />
        <MiniStat
          icon="globe"
          label="Sites affected"
          value={summary.sitesAffected}
          hint={`of ${summary.sitesScanned} scanned`}
          divider
        />
      </div>
    </Card>
  )
}

function MiniStat({
  icon,
  label,
  value,
  hint,
  divider = false,
}: {
  icon: React.ComponentProps<typeof Icon>['name']
  label: string
  value: number
  hint: string
  divider?: boolean
}) {
  return (
    <div className={`px-6 py-5 ${divider ? 'sm:border-l sm:border-c-line' : ''}`}>
      <p className="flex items-center gap-2 text-[12px] font-medium text-c-muted">
        <Icon name={icon} size={14} />
        {label}
      </p>
      <p className="console-num mt-2 text-2xl font-semibold leading-none tracking-tight text-c-ink">
        {value}
      </p>
      <p className="mt-1.5 text-[12px] text-c-muted">{hint}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Monitoring Panel                                                           */
/* -------------------------------------------------------------------------- */

function MonitoringPanel({ sites }: { sites: number }) {
  return (
    <Card title="Monitoring">
      <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-lg border border-c-line bg-c-soft text-c-muted">
          <Icon name="uptime" size={20} />
        </span>
        <p className="text-sm text-c-muted text-pretty">
          {sites === 0
            ? 'Nobody is watching a site yet.'
            : 'Scheduled re-scans and uptime checks are set per site.'}
        </p>
        {sites === 0 ? (
          <p className="text-[13px] text-c-muted">Add a site below to start watching it.</p>
        ) : (
          <CardAction href="#sites">Set up monitoring</CardAction>
        )}
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Needs Attention                                                            */
/* -------------------------------------------------------------------------- */

function NeedsAttention({ findings, scanned }: { findings: DashboardFinding[]; scanned: number }) {
  return (
    <Card
      title="Needs attention"
      action={
        findings.length > 0 ? <CardAction href="#sites">View all</CardAction> : null
      }
    >
      {findings.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-c-muted text-pretty">
          {scanned === 0
            ? 'Nothing scanned yet — run a scan above and the worst findings land here.'
            : 'No critical or high findings are open. That is the good outcome.'}
        </p>
      ) : (
        <ul className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {findings.map((finding) => (
            <li key={finding.id}>
              <Link
                href={`/scan/${finding.scanId}`}
                className="flex h-full flex-col gap-2 rounded-lg border border-c-line bg-c-card p-4
                           transition-colors hover:bg-c-soft"
              >
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em]">
                  <span className={SEVERITY_TEXT[finding.severity]}>{finding.severity}</span>
                  <span aria-hidden="true" className="text-c-line">·</span>
                  <span className="font-normal normal-case tracking-normal text-c-muted">
                    {finding.category === 'aeo' ? 'AI answers' : finding.category}
                  </span>
                </p>
                <p className="text-sm font-medium leading-snug text-pretty text-c-ink">
                  {finding.title}
                </p>
                <p className="mt-auto truncate text-[13px] text-c-muted">{finding.host}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Asset Summary                                                              */
/* -------------------------------------------------------------------------- */

function AssetSummary({
  sites,
  scans,
  scanned,
  avg,
}: {
  sites: number
  scans: number
  scanned: number
  avg: number | null
}) {
  return (
    <section>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <BigStat icon="globe" label="Domains" value={String(sites)} hint="tracked as projects" />
        <BigStat icon="search" label="Sites scanned" value={String(scanned)} hint="with a result" />
        <BigStat icon="feed" label="Ad-hoc scans" value={String(scans)} hint="not in a project" />
        <BigStat
          icon="shield"
          label="Average score"
          value={avg === null ? '—' : String(avg)}
          hint={avg === null ? 'no scans yet' : 'across every scan'}
          {...(avg === null ? {} : { tone: scoreTone(avg) })}
        />
      </div>
    </section>
  )
}

function BigStat({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentProps<typeof Icon>['name']
  label: string
  value: string
  hint: string
  tone?: string
}) {
  return (
    <div className="rounded-lg border border-c-line bg-c-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="flex items-center gap-2 text-[12px] font-medium text-c-muted">
        <Icon name={icon} size={14} />
        {label}
      </p>
      <p
        className={`console-num mt-3 text-2xl font-semibold leading-none tracking-tight ${tone ?? 'text-c-ink'}`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[12px] text-c-muted">{hint}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Issue Types                                                                */
/* -------------------------------------------------------------------------- */

function IssueTypes({ summary }: { summary: DashboardSummary }) {
  const peak = Math.max(1, ...PILLARS.map((p) => summary.byCategory[p.key]))

  return (
    <Card title="Issue types" action={<span className="text-[12px] text-c-muted">by pillar</span>}>
      <ul className="flex flex-col gap-4 px-6 py-6">
        {PILLARS.map((pillar) => {
          const n = summary.byCategory[pillar.key]
          return (
            <li key={pillar.key} className="flex items-center gap-4">
              <span className="w-28 shrink-0 text-[13px] text-c-body sm:w-36">{pillar.label}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-c-soft">
                <span
                  className={`block h-full rounded-full transition-all duration-500 ${
                    n > 0 ? 'bg-c-accent' : 'bg-transparent'
                  }`}
                  style={{ width: `${(n / peak) * 100}%` }}
                />
              </span>
              <span className="console-num w-8 shrink-0 text-right text-[13px] font-medium text-c-ink">
                {n}
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Sites                                                                      */
/* -------------------------------------------------------------------------- */

function Sites({ projects, orgId }: { projects: ProjectSummary[]; orgId: string }) {
  return (
    <section id="sites" className="scroll-mt-20">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-sm font-medium text-c-ink">Domains</h2>
        <NewProjectForm orgId={orgId} />
      </div>

      {projects.length === 0 ? (
        <div className="rounded-lg border border-c-line bg-c-card px-6 py-10 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <p className="text-sm font-medium text-c-ink">No domains tracked yet</p>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-c-muted text-pretty">
            Add a site to keep its history and watch its score move, or scan any URL above and file
            that report into a domain afterwards.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          {projects.map((summary) => (
            <ProjectRow key={summary.project.id} summary={summary} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ProjectRow({ summary }: { summary: ProjectSummary }) {
  const { project, latest, delta } = summary
  const score = latest?.scores?.overall ?? null
  const failed = latest?.status === 'failed'

  return (
    <li className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-c-line">
      <Link
        href={`/projects/${project.id}`}
        className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-c-soft/60"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-c-line bg-c-soft text-c-muted">
          <Icon name="globe" size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-c-ink">{project.name}</span>
          <span className="block truncate text-[13px] text-c-muted">{project.url}</span>
        </span>
        {score !== null ? (
          <span className="flex shrink-0 items-center gap-4">
            <span className="hidden sm:inline">
              <DeltaTag delta={delta} />
            </span>
            <span className={`console-num text-xl font-semibold tracking-tight ${scoreTone(score)}`}>
              {score}
            </span>
          </span>
        ) : (
          <span className="shrink-0 text-[13px] text-c-muted">
            {failed ? 'last scan failed' : 'not scanned yet'}
          </span>
        )}
      </Link>
    </li>
  )
}

function DeltaTag({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="text-[12px] text-c-muted">coverage changed</span>
  if (delta === 0) return <span className="text-[12px] text-c-muted">no change</span>
  const up = delta > 0
  return (
    <span
      className={`console-num text-[12px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-sev-high'}`}
    >
      {up ? `+${delta}` : `${delta}`}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Recent Scans                                                               */
/* -------------------------------------------------------------------------- */

function RecentScans({ scans }: { scans: Scan[] }) {
  return (
    <Card title="Recent scans" action={<span className="text-[12px] text-c-muted">not filed under a domain</span>}>
      <ul>
        {scans.map((scan) => {
          const score = scan.scores?.overall ?? null
          return (
            <li
              key={scan.id}
              className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-c-line"
            >
              <Link
                href={`/scan/${scan.id}`}
                className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-c-soft/60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-c-ink">
                    {hostOf(scan.url)}
                  </span>
                  <span className="console-num block truncate text-[12px] text-c-muted">
                    {stamp(scan.createdAt)}
                  </span>
                </span>
                {score !== null ? (
                  <span
                    className={`console-num text-lg font-semibold tracking-tight ${scoreTone(score)}`}
                  >
                    {score}
                  </span>
                ) : (
                  <span className="text-[13px] text-c-muted">
                    {scan.status === 'failed'
                      ? 'failed'
                      : scan.status === 'queued' || scan.status === 'running'
                        ? `${scan.status}…`
                        : '—'}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
