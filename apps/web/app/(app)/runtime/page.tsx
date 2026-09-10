import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  countOpenFindings,
  getRuntimeProjectContext,
  listFindings,
  listProberTargets,
  listProjects,
  type runtimeProberTargets,
} from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { hasRuntimeAccess } from '@/lib/entitlements.ts'
import { PageHeader } from '@/components/console/page-header.tsx'
import { Icon } from '@/components/console/icons.tsx'
import { ProberFindings } from '@/components/runtime/prober-findings.tsx'
import { ProberControls } from './probers/prober-controls.tsx'

export const metadata = { title: 'Runtime Auth Prober — ScanlyFix' }

type ProberTarget = typeof runtimeProberTargets.$inferSelect

export default async function RuntimePage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string }>
}) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') notFound()

  const projects = await listProjects(viewer)
  const sp = searchParams ? await searchParams : {}
  const activeProject = projects.find((p) => p.id === sp?.projectId) ?? projects[0]

  if (!activeProject) {
    return (
      <div className="console min-h-dvh bg-c-bg text-c-ink">
        <PageHeader title="Runtime — Auth Prober" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-c-soft text-c-ink">
              <Icon name="shield" size={24} />
            </div>
            <h2 className="text-lg font-semibold text-c-ink">No projects under watch</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">
              Runtime auth probing monitors protected endpoints on your domains. Add a project from the
              dashboard to start.
            </p>
            <Link
              href="/dashboard#sites"
              className="mt-6 inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            >
              Add a domain
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const projectId = activeProject.id
  const ctx = await getRuntimeProjectContext(projectId)

  // Gate 1: Domain verification
  if (!ctx?.isVerified) {
    return (
      <div className="console min-h-dvh bg-c-bg text-c-ink">
        <PageHeader title="Runtime — Auth Prober" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          <ProjectSelector projects={projects} activeProjectId={projectId} />
          <GateCard
            title="Verify your domain first"
            body="Probing sends real requests to your endpoints as a logged-out visitor. To prevent misuse, domain ownership must be verified before probes can run."
            cta={{ label: 'Verify domain', href: `/projects/${projectId}/verify` }}
          />
        </div>
      </div>
    )
  }

  // Gate 2: Pro plan check
  const hasAccess = await hasRuntimeAccess(viewer, projectId)
  if (!hasAccess) {
    return (
      <div className="console min-h-dvh bg-c-bg text-c-ink">
        <PageHeader title="Runtime — Auth Prober" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          <ProjectSelector projects={projects} activeProjectId={projectId} />
          <GateCard
            title="Auth prober is a Pro feature"
            body="Nightly automated prober checks whether sensitive pages that previously required login have accidentally become publicly accessible."
            cta={{ label: 'Upgrade to Pro', href: '/settings/billing' }}
          />
        </div>
      </div>
    )
  }

  const [targets, findings, openCount] = await Promise.all([
    listProberTargets(projectId),
    listFindings(projectId, false),
    countOpenFindings(projectId),
  ])

  const hasBaseline = targets.some((t) => t.baselineStatus !== null)

  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Runtime — Auth Prober" />

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">
        {/* Project switcher */}
        {projects.length > 1 && (
          <ProjectSelector projects={projects} activeProjectId={projectId} />
        )}

        {/* Subnav between Prober, Guard, and AI */}
        <div className="flex items-center gap-2 border-b border-c-line pb-3">
          <span className="rounded-lg bg-c-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm">
            Auth Prober
          </span>
          <Link
            href={`/runtime/guard?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            Guard Routes
          </Link>
          <Link
            href={`/runtime/ai?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            AI Spend &amp; Logs
          </Link>
        </div>

        {/* Feature banner */}
        <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 items-center rounded-md bg-emerald-500/10 px-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  Active
                </span>
                <h2 className="text-base font-semibold text-c-ink">{activeProject.name}</h2>
              </div>
              <p className="mt-1 text-sm text-c-muted">
                Nightly logged-out prober monitors sensitive routes. Flags pages that previously required login
                (401/403/30x) but now respond with 200 OK.
              </p>
            </div>
            <div className="shrink-0 pt-2 sm:pt-0">
              <ProberControls projectId={projectId} hasBaseline={hasBaseline} targetCount={targets.length} />
            </div>
          </div>
        </div>

        {/* Findings section */}
        <ProberFindings projectId={projectId} findings={findings} openCount={openCount} />

        {/* Targets list */}
        <section className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wider text-c-muted">
                Monitored Paths ({targets.length})
              </h3>
              <p className="text-xs text-c-muted">Baseline status vs latest check response</p>
            </div>
          </div>

          <TargetsTable targets={targets} />
        </section>
      </div>
    </div>
  )
}

function ProjectSelector({
  projects,
  activeProjectId,
}: {
  projects: Array<{ id: string; name: string; url: string }>
  activeProjectId: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-c-line pb-4">
      <span className="text-xs font-medium uppercase tracking-wider text-c-muted">Project:</span>
      {projects.map((p) => {
        const isActive = p.id === activeProjectId
        return (
          <Link
            key={p.id}
            href={`/runtime?projectId=${p.id}`}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive
                ? 'bg-c-accent text-white shadow-sm'
                : 'border border-c-line bg-c-card text-c-muted hover:border-c-line/80 hover:text-c-ink'
            }`}
          >
            {p.name}
          </Link>
        )
      })}
    </div>
  )
}

function GateCard({
  title,
  body,
  cta,
}: {
  title: string
  body: string
  cta: { label: string; href: string }
}) {
  return (
    <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <Icon name="shield" size={24} />
      </div>
      <h2 className="text-lg font-semibold text-c-ink">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">{body}</p>
      <Link
        href={cta.href}
        className="mt-6 inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
      >
        {cta.label}
      </Link>
    </div>
  )
}

function TargetsTable({ targets }: { targets: ProberTarget[] }) {
  if (targets.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-c-muted">
        No targets configured yet. Run the prober to seed standard sensitive routes.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-c-line text-xs font-medium uppercase tracking-wider text-c-muted">
            <th className="py-3 pr-4">Path</th>
            <th className="px-4 py-3">Method</th>
            <th className="px-4 py-3">Baseline</th>
            <th className="px-4 py-3">Latest Status</th>
            <th className="px-4 py-3">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-c-line">
          {targets.map((t) => {
            const isOk =
              t.baselineStatus !== null &&
              t.lastActualStatus !== null &&
              t.lastActualStatus === t.baselineStatus
            return (
              <tr key={t.id} className="hover:bg-c-soft/50">
                <td className="py-3 pr-4 font-mono text-xs font-semibold text-c-ink">{t.path}</td>
                <td className="px-4 py-3 text-xs text-c-muted">{t.method}</td>
                <td className="px-4 py-3 text-xs">
                  {t.baselineStatus ? (
                    <span className="inline-flex items-center rounded bg-c-soft px-2 py-0.5 font-mono text-xs font-medium text-c-ink">
                      {t.baselineStatus}
                    </span>
                  ) : (
                    <span className="text-c-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {t.lastActualStatus ? (
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-xs font-medium ${
                        isOk
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {t.lastActualStatus}
                    </span>
                  ) : (
                    <span className="text-c-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-c-muted">{t.source}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
