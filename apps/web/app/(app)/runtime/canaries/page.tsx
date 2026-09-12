import { notFound } from 'next/navigation';

import {
  getCanaryProjectConfig, listCanaries, listCanaryEvents,
} from '@scanlyfix/db';

import { CanaryConsole } from './canary-console';
import { requireUser } from '@/lib/authz';
import { getViewer } from '@/lib/authz';
import { hasRuntimeAccess } from '@/lib/entitlements';
import { getProject } from '@scanlyfix/db';
import { decryptValue } from '@/lib/header-encryption';

export default async function CanariesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const user = await requireUser();
  const viewer = await getViewer();
  const project = await getProject(projectId, viewer);
  if (!project) notFound();

  if (!(await hasRuntimeAccess(viewer, projectId))) {
    return (
      <GateCard
        title="Canaries are not on your plan"
        body="Database me decoy rows — jinhe koi legitimate code kabhi touch nahi karta. Touch hui, to koi andar tha. Scanner findings ki tarah nahi — fact hai, no triage, no false positive."
        cta={{ label: 'See the plans', href: '/settings/billing' }}
      />
    );
  }

  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  const canaries = await listCanaries(projectId);
  const events = await listCanaryEvents(projectId);
  const connected = cfg !== null;
  const planted = canaries.some((c) => c.status === 'planted');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Canaries</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Decoys in your database that nothing legitimate ever reads or writes. If one is touched,
          someone was in there — aur unlike a scanner finding, there is nothing to triage and no
          false positive to argue with.
        </p>
      </header>

      <CanaryConsole
        projectId={projectId}
        connected={connected}
        planted={planted}
        anonKeyConnected={cfg?.anonKey != null}
        canaries={canaries.map((c) => ({
          marker: c.markerToken, status: c.status,
          integrity: c.lastIntegrity, lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
        }))}
        events={events.map((e) => ({
          id: e.id, kind: e.kind, detail: e.detail, source: e.source,
          detectedAt: e.detectedAt.toISOString(),
        }))}
      />
    </div>
  );
}

function GateCard({ title, body, cta }: { title: string; body: string; cta: { label: string; href: string } }) {
  return (
    <div className="rounded-xl border p-8 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{body}</p>
      <a href={cta.href} className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        {cta.label}
      </a>
    </div>
  );
}