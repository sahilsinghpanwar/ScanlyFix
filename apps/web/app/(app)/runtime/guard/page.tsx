import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listGuardRoutes, listProjects } from '@scanlyfix/db';

import { GuardRoutesTable, GuardSetupCard, type GuardRouteView } from '@/components/runtime/guard-routes.tsx';
import { getViewer } from '@/lib/authz.ts';
import { hasRuntimeAccess } from '@/lib/entitlements.ts';
import { computeNeedsSession } from '@/lib/runtime/guard/heuristic.ts';
import { PageHeader } from '@/components/console/page-header.tsx';
import { Icon } from '@/components/console/icons.tsx';

export const metadata = { title: 'Runtime Guard — ScanlyFix' };

export default async function GuardPage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string }>;
}) {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') notFound();

  const projects = await listProjects(viewer);
  const sp = searchParams ? await searchParams : {};
  const activeProject = projects.find((p) => p.id === sp?.projectId) ?? projects[0];

  if (!activeProject) {
    return (
      <div className="console min-h-dvh bg-c-bg text-c-ink">
        <PageHeader title="Runtime — Guard" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-c-ink">No projects under watch</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">
              Add a project from the dashboard to start observing routes and server actions with Guard.
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
    );
  }

  const projectId = activeProject.id;

  // Gate: Pro plan check
  const hasAccess = await hasRuntimeAccess(viewer, projectId);
  if (!hasAccess) {
    return (
      <div className="console min-h-dvh bg-c-bg text-c-ink">
        <PageHeader title="Runtime — Guard" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          <ProjectSelector projects={projects} activeProjectId={projectId} />
          <GateCard
            title="Guard is a Pro feature"
            body="Runtime Guard records which routes and server actions are actually exposed by your application, allowing nightly probers to test real protected endpoints instead of guesswork."
            cta={{ label: 'Upgrade to Pro', href: '/settings/billing' }}
          />
        </div>
      </div>
    );
  }

  const routes = await listGuardRoutes(projectId);

  const view: GuardRouteView[] = routes.map((r) => ({
    ...r,
    needsSession: computeNeedsSession(r.withSession, r.withoutSession, r.source),
  }));

  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Runtime — Guard" />

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">
        {projects.length > 1 && (
          <ProjectSelector projects={projects} activeProjectId={projectId} />
        )}

        {/* Subnav between Prober, Guard, and AI */}
        <div className="flex items-center gap-2 border-b border-c-line pb-3">
          <Link
            href={`/runtime?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            Auth Prober
          </Link>
          <span className="rounded-lg bg-c-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm">
            Guard Routes
          </span>
          <Link
            href={`/runtime/ai?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            AI Spend &amp; Logs
          </Link>
        </div>

        {/* Feature Header */}
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
                Observed from inside your application — captures real routes and server actions.
                Endpoints classified as needing a session are automatically fed to the nightly Auth Prober.
              </p>
            </div>
          </div>
        </div>

        {view.length === 0 ? (
          <GuardSetupCard projectId={projectId} />
        ) : (
          <GuardRoutesTable projectId={projectId} routes={view} />
        )}
      </div>
    </div>
  );
}

function ProjectSelector({
  projects,
  activeProjectId,
}: {
  projects: Array<{ id: string; name: string; url: string }>;
  activeProjectId: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-c-line pb-4">
      <span className="text-xs font-medium uppercase tracking-wider text-c-muted">Project:</span>
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        return (
          <Link
            key={p.id}
            href={`/runtime/guard?projectId=${p.id}`}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive
                ? 'bg-c-accent text-white shadow-sm'
                : 'border border-c-line bg-c-card text-c-muted hover:border-c-line/80 hover:text-c-ink'
            }`}
          >
            {p.name}
          </Link>
        );
      })}
    </div>
  );
}

function GateCard({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta: { label: string; href: string };
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
  );
}