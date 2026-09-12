'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { GuardRouteRow } from '@scanlyfix/db';
import {
  refreshGuardAction,
  simulateSampleTrafficAction,
  clearGuardRoutesAction,
  getOrCreateRuntimeSecretAction,
  rotateRuntimeSecretAction,
} from '@/app/(app)/runtime/guard/actions';

export type GuardRouteView = GuardRouteRow & { needsSession: boolean };

const NEW_ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const SETUP_SNIPPET = `// middleware.ts
import { withGuard } from '@scanlyfix/runtime-sdk';

export default withGuard();

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};`;

// ── CopyButton ────────────────────────────────────────────────────────────────
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={copy}
      className="inline-flex h-6 items-center justify-center rounded px-2 text-[10px] font-medium transition-colors border border-c-line bg-c-card text-c-muted hover:text-c-ink hover:bg-c-soft"
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

// ── SdkKeysCard ───────────────────────────────────────────────────────────────
function SdkKeysCard({ projectId, origin }: { projectId: string; origin: string }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotating, startRotate] = useTransition();
  const [rotateWarning, setRotateWarning] = useState(false);

  // Lazily load (or generate) the per-project signing secret on mount.
  useEffect(() => {
    getOrCreateRuntimeSecretAction(projectId).then((res) => {
      if (res.ok) setSecret(res.secret);
      setLoading(false);
    });
  }, [projectId]);

  const ingestUrl = `${origin}/api/runtime/ingest`;

  const envBlock = [
    `RUNTIME_PROJECT_ID=${projectId}`,
    `RUNTIME_INGEST_URL=${ingestUrl}`,
    `RUNTIME_SIGNING_SECRET=${secret ?? '<loading…>'}`,
  ].join('\n');

  function handleRotate() {
    if (!confirm(
      'Regenerate signing secret?\n\nYour SDK instances will receive 401 errors until you update RUNTIME_SIGNING_SECRET in your .env and redeploy.'
    )) return;
    setRotateWarning(false);
    startRotate(async () => {
      const res = await rotateRuntimeSecretAction(projectId);
      if (res.ok) {
        setSecret(res.secret);
        setRotateWarning(true);
        setTimeout(() => setRotateWarning(false), 8000);
      }
    });
  }

  return (
    <div className="rounded-xl border border-c-line bg-c-card shadow-sm">
      <div className="flex items-center justify-between border-b border-c-line px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-c-muted">
          SDK Environment Variables
        </h3>
        <div className="flex items-center gap-2">
          {secret && <CopyButton text={envBlock} label="Copy all" />}
          <button
            onClick={handleRotate}
            disabled={rotating || loading}
            className="inline-flex h-6 items-center justify-center rounded px-2 text-[10px] font-medium border border-rose-200 text-rose-500 hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-950 transition-colors disabled:opacity-40"
          >
            {rotating ? 'Rotating…' : 'Regenerate'}
          </button>
        </div>
      </div>

      <div className="divide-y divide-c-line">
        {/* RUNTIME_PROJECT_ID */}
        <div className="flex items-center gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-c-muted">
              RUNTIME_PROJECT_ID
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-c-ink">{projectId}</p>
          </div>
          <CopyButton text={projectId} />
        </div>

        {/* RUNTIME_INGEST_URL */}
        <div className="flex items-center gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-c-muted">
              RUNTIME_INGEST_URL
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-c-ink">{ingestUrl}</p>
          </div>
          <CopyButton text={ingestUrl} />
        </div>

        {/* RUNTIME_SIGNING_SECRET */}
        <div className="flex items-center gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-c-muted">
              RUNTIME_SIGNING_SECRET
            </p>
            {loading ? (
              <p className="mt-0.5 font-mono text-xs text-c-muted animate-pulse">Generating…</p>
            ) : secret ? (
              <p className="mt-0.5 truncate font-mono text-xs text-c-ink">{secret}</p>
            ) : (
              <p className="mt-0.5 font-mono text-xs text-rose-500">Failed to load — refresh page</p>
            )}
          </div>
          {secret && <CopyButton text={secret} />}
        </div>
      </div>

      <div className="border-t border-c-line px-5 py-3">
        <p className="text-[11px] text-c-muted">
          <span className="font-semibold text-amber-600 dark:text-amber-400">⚠ Keep secret:</span>{' '}
          Add these to your Next.js app's{' '}
          <code className="rounded bg-c-soft px-1 font-mono text-[10px]">.env.local</code> (or Vercel
          environment variables). Never commit <code className="rounded bg-c-soft px-1 font-mono text-[10px]">RUNTIME_SIGNING_SECRET</code> to git.
        </p>
        {rotateWarning && (
          <p className="mt-2 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
            Secret rotated — update RUNTIME_SIGNING_SECRET in your app and redeploy, or the SDK will receive 401 errors.
          </p>
        )}
      </div>
    </div>
  );
}

// ── GuardSetupCard ────────────────────────────────────────────────────────────
export function GuardSetupCard({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [origin, setOrigin] = useState('https://scanlyfix.com');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  function handleSimulate() {
    setMsg(null);
    startTransition(async () => {
      const res = await simulateSampleTrafficAction(projectId);
      if (res.ok) {
        setMsg(`Sample traffic simulated successfully (${res.syncedTargets} routes generated).`);
        router.refresh();
      } else {
        setMsg(`Error: ${res.error}`);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Setup instructions */}
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-c-ink">Nothing has reported in from your app yet</h3>
            <p className="mt-1 text-sm text-c-muted">
              Guard connects via a lightweight middleware wrapper. Once configured, this dashboard reflects every real
              route and server action observed across live traffic.
            </p>
          </div>
          <button
            onClick={handleSimulate}
            disabled={pending}
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-c-accent px-3 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Simulating...' : 'Simulate Sample Traffic'}
          </button>
        </div>
        {msg && (
          <p className="mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {msg}
          </p>
        )}

        {/* Step 1: install command */}
        <div className="mt-5">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-semibold text-c-muted">Step 1 — Install the SDK in your Next.js app</p>
            <CopyButton text="npm install @scanlyfix/runtime-sdk" label="Copy" />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">
            npm install @scanlyfix/runtime-sdk
          </pre>
          <p className="mt-1.5 text-[11px] text-c-muted">
            For local multi-project testing before npm publishing: <code className="rounded bg-c-soft px-1 font-mono text-[10px]">npm install /Users/sahilpanwar/Ghost/PROJECTS/darvin/packages/runtime-sdk</code>
          </p>
        </div>

        {/* Step 2: middleware snippet */}
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-semibold text-c-muted">Step 2 — Add to your app's middleware.ts</p>
            <CopyButton text={SETUP_SNIPPET} label="Copy" />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">
            {SETUP_SNIPPET}
          </pre>
          <p className="mt-1.5 text-[11px] text-c-muted">
            <span className="font-semibold text-c-ink">Tip:</span> If you already have auth middleware (e.g. Supabase, NextAuth), wrap it directly:{' '}
            <code className="rounded bg-c-soft px-1 font-mono text-[10px]">export default withGuard(myAuthMiddleware);</code>
          </p>
        </div>

        {/* Step 3: env vars card */}
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-c-muted">Step 3 — Set environment variables in .env.local</p>
            <span className="rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              ⚡ Domain Auto-Detection Active
            </span>
          </div>
          <p className="mb-2 text-[11px] text-c-muted">
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">Multi-project testing:</span> When deployed, you can omit <code className="rounded bg-c-soft px-1 font-mono text-[10px]">RUNTIME_PROJECT_ID</code>. ScanlyFix automatically identifies your project from the incoming domain.
          </p>
          <SdkKeysCard projectId={projectId} origin={origin} />
        </div>
      </div>

      {/* What leaves your app */}
      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-c-ink">What leaves your app</h3>
        <ul className="mt-3 space-y-2 text-sm text-c-muted">
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            Route patterns, normalized to file-tree representation (<code className="font-mono text-xs text-c-ink">/api/users/[id]</code>)
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            HTTP method, server action indicator, and counts of requests with vs. without session
          </li>
          <li className="flex items-center gap-2 text-rose-500">
            <span>✗</span>
            Never collected: request/response bodies, authorization headers, cookie values, or sensitive tokens
          </li>
        </ul>
        <p className="mt-3 text-xs text-c-muted">
          Reporting runs non-blocking in the background — telemetry never slows down your application requests.
        </p>
      </div>
    </div>
  );
}

// ── GuardRoutesTable ──────────────────────────────────────────────────────────
export function GuardRoutesTable({ projectId, routes }: { projectId: string; routes: GuardRouteView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const realRoutes = routes.filter((r) => r.source !== 'sample');
  const sampleCount = routes.length - realRoutes.length;

  function refresh() {
    setSyncMsg(null);
    startTransition(async () => {
      const res = await refreshGuardAction(projectId);
      if (res.ok) {
        setSyncMsg(`Synced ${res.syncedTargets} protected route(s) to Prober targets!`);
        router.refresh();
      } else {
        setSyncMsg(`Sync failed: ${res.error}`);
      }
    });
  }

  function handleClear() {
    const confirmation = prompt('Type CLEAR to delete all observed routes and synced guard prober targets:');
    if (!confirmation || confirmation.trim().toUpperCase() !== 'CLEAR') {
      return;
    }
    setSyncMsg(null);
    startTransition(async () => {
      const res = await clearGuardRoutesAction(projectId, confirmation);
      if (res.ok) {
        setSyncMsg(
          `Cleared ${res.deletedRoutes} route(s) and ${res.deletedTargets} synced guard target(s).`,
        );
        router.refresh();
      } else {
        setSyncMsg(`Clear failed: ${res.error}`);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-c-muted">
            {realRoutes.length} real routes observed
            {sampleCount > 0 && (
              <span className="ml-1 text-[11px] font-normal text-amber-600 dark:text-amber-400">
                (+{sampleCount} sample)
              </span>
            )}
          </p>
          {syncMsg && (
            <p className="mt-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {syncMsg}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleClear}
            disabled={pending}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-muted hover:text-rose-600 dark:hover:text-rose-400 transition-colors hover:bg-c-soft disabled:opacity-50 shrink-0"
          >
            Clear Routes
          </button>
          <button
            onClick={refresh}
            disabled={pending}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm transition-colors hover:bg-c-soft disabled:opacity-50 shrink-0"
          >
            {pending ? 'Syncing...' : 'Sync to Prober'}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-c-line bg-c-card shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-c-line text-xs font-medium uppercase tracking-wider text-c-muted">
              <th className="px-4 py-3">Pattern</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Session Ratio</th>
              <th className="px-4 py-3">Total Requests</th>
              <th className="px-4 py-3">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-c-line">
            {routes.map((r) => {
              const total = r.withSession + r.withoutSession;
              const pct = total > 0 ? Math.round((r.withSession / total) * 100) : 0;
              const isNew = Date.now() - new Date(r.firstSeenAt).getTime() < NEW_ROUTE_WINDOW_MS;
              return (
                <tr key={r.id} className="hover:bg-c-soft/50">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-c-ink">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>{r.pattern}</span>
                      {r.source === 'sample' && (
                        <span className="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          sample
                        </span>
                      )}
                      {isNew && (
                        <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                          new
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                        r.kind === 'server_action'
                          ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                          : 'bg-c-soft text-c-muted'
                      }`}
                    >
                      {r.kind === 'server_action' ? 'action' : r.method}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-c-soft">
                        <div className="h-full rounded-full bg-c-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="font-mono text-xs text-c-muted">{pct}%</span>
                      {r.needsSession && (
                        <span className="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-600 dark:text-sky-400">
                          needs session → probed nightly
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-c-muted">{total}</td>
                  <td className="px-4 py-3 text-xs text-c-muted">
                    {new Date(r.lastSeenAt).toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}