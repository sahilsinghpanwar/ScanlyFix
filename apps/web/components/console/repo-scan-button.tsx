'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { shake } from '@/components/console/motion.ts'

/**
 * Triggers a repo scan via the existing POST /api/repos/scan endpoint.
 *
 * The endpoint handles auth, ownership verification, and enqueueing — this
 * button only needs to POST and refresh the page so the scan status appears.
 * A failed request shakes the button once per failure, next to the error text
 * that says why.
 *
 * Shared by the feed's repository rows, the dashboard's repository card and
 * the per-repo report page, so one component owns the trigger everywhere.
 */
export function RepoScanButton({
  repoId,
  label = 'Scan',
  pendingLabel = 'Scanning…',
  tone = 'solid',
}: {
  repoId: string
  label?: string
  pendingLabel?: string
  /** 'solid' — the filled ink pill (feed rows). 'quiet' — bordered (dashboard card). */
  tone?: 'solid' | 'quiet'
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (error) void shake(buttonRef.current)
  }, [error])

  async function handleScan() {
    setError(null)
    try {
      const res = await fetch('/api/repos/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoId, profile: 'shallow' }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Scan failed')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError('Could not reach the server')
    }
  }

  const base =
    'rounded-full px-5 py-2 text-[13px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60'
  const solid = 'bg-c-ink text-c-brand-ink'
  const quiet = 'border border-c-line bg-c-card text-c-ink hover:bg-c-soft'

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleScan}
        data-press=""
        disabled={pending}
        className={`${base} ${tone === 'solid' ? solid : quiet}`}
      >
        {pending ? pendingLabel : label}
      </button>
      {error && (
        <p className="max-w-[160px] text-right text-[11px] text-sev-high">{error}</p>
      )}
    </div>
  )
}