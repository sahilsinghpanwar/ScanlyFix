'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { runtimeProberTargets } from '@scanlyfix/db';
import { calculateBaselineAgeDays, detectFlappingPaths } from '@/lib/runtime/auth-prober/flap';
import { addTargetAction, deleteTargetAction, rerecordBaselineAction } from './action';

type ProberTarget = typeof runtimeProberTargets.$inferSelect;

export function TargetManager({
  projectId,
  targets,
  findings = [],
}: {
  projectId: string;
  targets: ProberTarget[];
  findings?: Array<{ path: string; createdAt: Date | string }>;
}) {
  const router = useRouter();
  const [newPath, setNewPath] = useState('');
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const flapAnalysis = detectFlappingPaths(findings);

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newPath.trim()) return;

    setMsg(null);
    startTransition(async () => {
      const res = await addTargetAction(projectId, newPath.trim());
      if (res.ok) {
        setNewPath('');
        setMsg({ text: res.message ?? 'Target added successfully!' });
        router.refresh();
      } else {
        setMsg({ text: res.error, error: true });
      }
    });
  }

  function handleRerecord(targetId: string, path: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await rerecordBaselineAction(projectId, targetId);
      if (res.ok) {
        setMsg({ text: res.message ?? `Re-recorded baseline for ${path}.` });
        router.refresh();
      } else {
        setMsg({ text: res.error, error: true });
      }
    });
  }

  function handleDelete(targetId: string, path: string) {
    if (!confirm(`Remove "${path}" from monitored targets?`)) return;

    setMsg(null);
    startTransition(async () => {
      const res = await deleteTargetAction(projectId, targetId);
      if (res.ok) {
        setMsg({ text: res.message ?? 'Target removed.' });
        router.refresh();
      } else {
        setMsg({ text: res.error, error: true });
      }
    });
  }

  const manualCount = targets.filter((t) => t.source === 'manual').length;
  const isCapReached = manualCount >= 25;

  return (
    <div className="space-y-4">
      {/* Header with target limits */}
      <div className="flex items-center justify-between text-xs text-c-muted">
        <span>
          Manual routes:{' '}
          <span className={`font-medium ${isCapReached ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-c-ink'}`}>
            {manualCount}/25
          </span>
        </span>
        <span className="text-[11px] text-c-muted font-mono">Method: GET</span>
      </div>

      {/* Add Custom Route Form */}
      <form onSubmit={handleAdd} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            disabled={isCapReached}
            placeholder={
              isCapReached
                ? 'Maximum limit of 25 manual targets reached'
                : 'Add sensitive route to probe (e.g. /api/admin, /internal/keys)'
            }
            className="w-full rounded-lg border border-c-line bg-c-soft px-3 py-1.5 font-mono text-xs text-c-ink shadow-sm focus:outline-none focus:ring-1 focus:ring-c-accent disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={pending || !newPath.trim() || isCapReached}
          className="inline-flex h-8 items-center justify-center rounded-lg bg-c-accent px-3 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50 shrink-0"
        >
          {pending ? 'Saving...' : '+ Add Route'}
        </button>
      </form>

      {msg && (
        <p
          className={`text-xs font-medium ${
            msg.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {msg.text}
        </p>
      )}

      {/* Table */}
      {targets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-c-line p-8 text-center">
          <p className="text-sm font-medium text-c-ink">No targets configured yet</p>
          <p className="mt-1 text-xs text-c-muted">
            Click &ldquo;Seed default routes &amp; probe&rdquo; above to automatically monitor standard sensitive paths, or add a custom path above.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-c-line text-xs font-medium uppercase tracking-wider text-c-muted">
                <th className="py-3 pr-4">Path</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Baseline</th>
                <th className="px-4 py-3">Baseline Age</th>
                <th className="px-4 py-3">Latest Status</th>
                <th className="px-4 py-3">Source</th>
                <th className="py-3 pl-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-c-line">
              {targets.map((t) => {
                const isOk =
                  t.baselineStatus !== null &&
                  t.lastActualStatus !== null &&
                  t.lastActualStatus === t.baselineStatus;
                const isUnstable = flapAnalysis.isUnstable(t.path);
                const baselineAgeDays = calculateBaselineAgeDays(t.baselineAt);
                const needsRerecord = baselineAgeDays !== null && baselineAgeDays > 180;

                return (
                  <tr key={t.id} className="hover:bg-c-soft/50">
                    <td className="py-3 pr-4 font-mono text-xs font-semibold text-c-ink">
                      <div className="flex items-center gap-2">
                        <span>{t.path}</span>
                        {isUnstable && (
                          <span
                            className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 border border-amber-500/20"
                            title="Flapping route: regressed 3 or more times in the last 30 days"
                          >
                            unstable
                          </span>
                        )}
                      </div>
                    </td>
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
                      {baselineAgeDays !== null ? (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-c-ink">{baselineAgeDays}d</span>
                          {needsRerecord && (
                            <button
                              type="button"
                              onClick={() => handleRerecord(t.id, t.path)}
                              disabled={pending}
                              className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors cursor-pointer"
                              title={`Baseline is ${baselineAgeDays} days old (>180d). Click to re-record baseline.`}
                            >
                              re-record baseline
                            </button>
                          )}
                        </div>
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
                    <td className="px-4 py-3 text-xs">
                      <span className="rounded bg-c-soft px-1.5 py-0.5 font-mono text-[10px] text-c-muted capitalize">
                        {t.source}
                      </span>
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <button
                        onClick={() => handleDelete(t.id, t.path)}
                        disabled={pending}
                        className="text-xs text-c-muted hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
                        title="Delete target"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
