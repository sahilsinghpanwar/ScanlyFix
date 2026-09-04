'use client'

/**
 * The confirmation step between sign-in and the scan itself.
 *
 * A visitor who typed a URL on the landing page and was sent to sign in lands
 * here with that URL still in sessionStorage (stashed by useScanSubmit on the
 * way out). The page shows the address back, asks with one button, and carries
 * the one warning that matters before work starts: the report is locked to
 * this address — once the scan begins it cannot be pointed somewhere else.
 * Confirming starts the scan, which then runs in the background; the visitor
 * is taken to the dashboard, where the loader and then the report appear.
 *
 * The read is a peek, not a take, on purpose: a refresh of this page must not
 * silently drop the address. The stash is consumed only when the scan is
 * actually started (or explicitly abandoned via the dashboard link, whose form
 * reclaims it). With nothing pending — a direct visit, or a refresh after the
 * scan already started — the dashboard is the honest next stop.
 *
 * Why a client component: the API call is a fetch and the redirect is a
 * router.push. The (app) layout's Supabase provider is what makes the
 * session cookie available to /api/scan, so this must run after that
 * provider has mounted.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  sessionStore,
  peekPendingUrl,
  stashPendingUrl,
  takePendingUrl,
} from '@/components/scan/pending-scan-url.ts'
import { normalizeScanTarget } from '@/lib/url.ts'
import { LabeledRule } from '@/components/ui/labeled-rule.tsx'
import { LogoBadge } from '@/components/brand/logo.tsx'

export function StartScanClient() {
  const router = useRouter()
  const [url, setUrl] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const raw = peekPendingUrl(sessionStore())
    if (raw === null) {
      // Nothing carried across sign-in — a direct visit, or a refresh after
      // the scan already started. The dashboard is the honest next stop.
      router.replace('/dashboard')
      return
    }
    setUrl(raw)
    setChecked(true)
  }, [router])

  async function confirm() {
    if (pending || url === null) return

    // The stash was written after this exact validation ran on the landing
    // page, but nothing arriving from storage is trusted either.
    const target = normalizeScanTarget(url)
    if (!target.ok) {
      setError(target.reason)
      return
    }

    // Consumed now: once the scan has been asked for, no other form on this
    // tab should restore an address the visitor has moved past.
    takePendingUrl(sessionStore())
    setError(null)
    setPending(true)

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: target.url }),
      })

      if (response.status === 401) {
        // The session cookie didn't reach the API — back to sign in, with the
        // URL re-stashed so the return trip lands here again, still filled.
        stashPendingUrl(sessionStore(), target.url)
        router.replace('/login?next=/scan/start')
        return
      }

      if (!response.ok) {
        const detail: unknown = await response.json().catch(() => null)
        const reason =
          detail && typeof detail === 'object' && 'error' in detail && typeof detail.error === 'string'
            ? detail.error
            : `The scan could not be started (HTTP ${response.status}).`
        setError(reason)
        // The stash is restored so a refresh stays on a working confirmation
        // instead of bouncing to the dashboard mid-retry.
        stashPendingUrl(sessionStore(), target.url)
        setPending(false)
        return
      }

      const { scanId } = (await response.json()) as { scanId: string }
      // The scan runs in the background; the dashboard is where its progress
      // and then the report are shown, so the visitor lands there.
      void scanId
      router.replace('/dashboard')
      // Deliberately left pending: the route change is in flight, and
      // re-enabling the button would invite a second scan on the way out.
    } catch {
      stashPendingUrl(sessionStore(), target.url)
      setError('Could not reach the scanner. Check your connection and try again.')
      setPending(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <div className="flex items-center gap-2.5">
          <LogoBadge size={34} />
          <span className="text-xl font-semibold tracking-tight">scanlyfix</span>
        </div>
        <div className="mt-8">
          <LabeledRule label="Report" trailing="confirm your scan" />
        </div>
      </header>

      <div className="mt-10 border border-line bg-surface p-6 sm:p-8">
        {!checked ? (
          <p className="text-[15px] leading-relaxed text-muted text-pretty">Loading…</p>
        ) : url !== null ? (
          <>
            <p className="text-[13px] leading-relaxed text-muted">
              You asked for a report on
            </p>
            <p className="console-num mt-3 border border-line bg-canvas px-4 py-3 text-[15px] leading-relaxed text-ink break-all">
              {url}
            </p>

            <p className="mt-5 flex items-start gap-2 text-[13px] leading-relaxed text-amber-700 dark:text-amber-400 text-pretty">
              <span aria-hidden="true">▲</span>
              <span>
                This report is locked to this address. Once the scan starts you
                will not be able to change it — every finding and fix prompt is
                for this URL only.
              </span>
            </p>

            {error && (
              <p role="alert" className="mt-4 text-[15px] leading-relaxed text-ink text-pretty">
                ▲ {error}
              </p>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={pending}
                className="label inline-flex h-11 items-center bg-ink px-6 text-canvas
                           transition-colors duration-150 hover:bg-transparent hover:text-ink border border-ink
                           disabled:opacity-60 disabled:hover:bg-ink disabled:hover:text-canvas"
              >
                {pending ? 'Starting…' : 'Start scan'}
              </button>
              <Link
                href="/dashboard"
                className="label inline-flex h-11 items-center px-4 text-muted
                           transition-colors duration-150 hover:text-ink"
              >
                Scan a different site
              </Link>
            </div>
          </>
        ) : (
          <p className="text-[15px] leading-relaxed text-muted text-pretty">
            Nothing to scan — taking you to the dashboard…
          </p>
        )}
      </div>
    </div>
  )
}
