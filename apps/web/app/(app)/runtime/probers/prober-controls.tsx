'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { runProberAction } from './action';
import { recordBaselineButtonLabel } from './prober-view';

export function ProberControls({ projectId, hasBaseline, targetCount }: {
  projectId: string;
  hasBaseline: boolean;
  targetCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const label = recordBaselineButtonLabel(hasBaseline, targetCount);

  function handleRun() {
    setMsg(null);
    startTransition(async () => {
      const res = await runProberAction(projectId);
      if (res.ok) {
        setMsg({ text: res.message ?? 'Prober run completed successfully!' });
        router.refresh();
      } else {
        setMsg({ text: `Failed: ${res.error}`, error: true });
      }
    });
  }

  return (
    <div className="flex flex-col sm:items-end gap-2">
      <div className="flex items-center gap-3">
        <button
          disabled={pending}
          onClick={handleRun}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Probing...' : label}
        </button>
        <span className="text-xs text-c-muted">
          {targetCount} target{targetCount !== 1 ? 's' : ''} monitored
        </span>
      </div>
      {msg && (
        <span
          className={`text-xs font-medium ${
            msg.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}
