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
import { TargetManager } from './probers/target-manager.tsx'

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
              <div className="mt-3 flex items-center gap-2 text-xs">
                {ctx?.anonKeyFingerprint ? (
                  <span className="inline-flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-purple-500" />
                    Public Supabase anon key detected (fingerprint:{' '}
                    <code className="font-mono">{ctx.anonKeyFingerprint}</code>) — anon-role probe active
                  </span>
                ) : ctx?.anonKeyCheckedAt ? (
                  <span className="inline-flex items-center gap-1.5 text-c-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-c-line" />
                    No public Supabase anon key detected on homepage (bare logged-out probing active)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-c-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    Anon-key detection pending next probe run
                  </span>
                )}
              </div>
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

          <TargetManager projectId={projectId} targets={targets} findings={findings} />

          <p className="mt-4 border-t border-c-line/60 pt-3 text-[11px] text-c-muted">
            * Note on dynamic routes: parameter placeholders (e.g. <code className="font-mono">[id]</code>,{' '}
            <code className="font-mono">[slug]</code>) are probed with safe test values. Dynamic routes whose substituted ID
            does not exist on your server return 404 (inconclusive) and produce no finding. This is by design to prevent false alarms.
          </p>
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
