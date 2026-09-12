import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getCurrentHourSpendMicroUsd,
  listRecentAiCalls,
  getSpendBreakdown,
  getSpendCeilingMicroUsd,
  getSpendLast24hMicroUsd,
  getSpendHourlyBuckets,
  listProjects,
} from '@scanlyfix/db';

import { AiConsole } from '@/components/runtime/ai-console.tsx';
import { getViewer } from '@/lib/authz.ts';
import { hasRuntimeAccess } from '@/lib/entitlements.ts';
import { buildAiSummary, projectEndOfHourMicroUsd } from '@/lib/runtime/ai-log/summary.ts';
import { PageHeader } from '@/components/console/page-header.tsx';
import { Icon } from '@/components/console/icons.tsx';

export const metadata = { title: 'Runtime AI Spend & Log — ScanlyFix' };

export default async function AiConsolePage({
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
        <PageHeader title="Runtime — AI Spend & Log" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-c-ink">No projects under watch</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">
              Add a project from the dashboard to start observing AI spend and token telemetry.
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
        <PageHeader title="Runtime — AI Spend & Log" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          {projects.length > 1 && (
            <ProjectSelector projects={projects} activeProjectId={projectId} />
          )}
          <GateCard
            title="AI Call Log & Spend is a Pro feature"
            body="A zero-proxy wrapper that attaches to your AI client — your API key stays in your process, requests go directly to providers, and ScanlyFix receives only metadata (model, tokens, latency). Spend is calculated to alert on runaway loops before high bills arrive."
            cta={{ label: 'Upgrade to Pro', href: '/settings/billing' }}
          />
        </div>
      </div>
    );
  }

  const [calls, breakdown, hourSpend, last24h, ceilingMicro, hourlyBuckets] = await Promise.all([
    listRecentAiCalls(projectId),
    getSpendBreakdown(projectId),
    getCurrentHourSpendMicroUsd(projectId),
    getSpendLast24hMicroUsd(projectId),
    getSpendCeilingMicroUsd(projectId),
    getSpendHourlyBuckets(projectId, 24),
  ]);

  const summary = buildAiSummary({ calls, byModel: breakdown.byModel, byUser: breakdown.byUser });

  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Runtime — AI Spend & Log" />

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
          <Link
            href={`/runtime/guard?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            Guard Routes
          </Link>
          <span className="rounded-lg bg-c-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm">
            AI Spend &amp; Logs
          </span>
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
                Client wrapper — not a proxy. Your API keys stay in your process, requests go directly to
                the provider, and only metadata is reported. Spend is calculated directly from your calls to match the exact numbers in your logs.
              </p>
            </div>
          </div>
        </div>

        <AiConsole
          projectId={projectId}
          summary={summary}
          hourSpendMicroUsd={hourSpend}
          projectedHourMicroUsd={projectEndOfHourMicroUsd(hourSpend)}
          last24hMicroUsd={last24h}
          ceilingMicroUsd={ceilingMicro}
          calls={calls}
          hourlyBuckets={hourlyBuckets}
        />
      </div>
    </div>
  );
}

function ProjectSelector({
  projects,
  activeProjectId,
}: {
  projects: Array<{ id: string; name: string }>;
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
            href={`/runtime/ai?projectId=${p.id}`}
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