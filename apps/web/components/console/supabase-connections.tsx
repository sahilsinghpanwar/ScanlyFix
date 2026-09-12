'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { shake } from '@/components/console/motion.ts'
import type { Connection } from '@scanlyfix/db'

/**
 * The feed's Supabase connections: connect, scan, disconnect.
 *
 * One client island owns all three actions because they share a failure
 * surface (inline error + one shake per failure, same as RepoScanButton) and
 * all end in a router.refresh() so the server component re-renders from the
 * database — the connection list the user sees is never a stale client copy.
 *
 * The copy is deliberate about the trust model: Level 1 means the
 * PUBLISHABLE key only, the validator refuses a service-role key by name,
 * and disconnect says plainly that our copy is destroyed while the key itself
 * stays valid until rotated in the user's dashboard.
 */

const SEVERITY_TEXT: Record<string, string> = {
  critical: 'text-sev-critical',
  high: 'text-sev-high',
  medium: 'text-sev-medium',
  low: 'text-sev-low',
  info: 'text-sev-info',
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const

function stamp(date: Date | string | null): string {
  if (!date) return 'never'
  const d = typeof date === 'string' ? new Date(date) : date
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const FIELD =
  'h-11 w-full border border-line bg-canvas px-4 text-sm placeholder:text-muted ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink'
const BUTTON =
  'label inline-flex h-11 items-center justify-center gap-2 px-6 transition-colors duration-150'
const PRIMARY = `${BUTTON} border border-ink bg-ink text-canvas hover:bg-transparent hover:text-ink`

function ConnectForm({ onDone }: { onDone: () => void }) {
  const router = useRouter()
  const [projectUrl, setProjectUrl] = useState('')
  const [key, setKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (error) void shake(formRef.current)
  }, [error])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'supabase', projectUrl, key }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? 'Could not save the connection.')
        return
      }
      setProjectUrl('')
      setKey('')
      onDone()
      router.refresh()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="sb-url" className="label text-muted">
            Project URL
          </label>
          <input
            id="sb-url"
            value={projectUrl}
            onChange={(event) => setProjectUrl(event.target.value)}
            disabled={pending}
            required
            placeholder="https://yourproject.supabase.co"
            className={`${FIELD} mt-1.5`}
          />
        </div>
        <div>
          <label htmlFor="sb-key" className="label text-muted">
            Publishable (anon) key
          </label>
          <input
            id="sb-key"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={pending}
            required
            autoComplete="off"
            placeholder="sb_publishable_… or eyJ…"
            className={`${FIELD} mt-1.5`}
          />
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-c-muted">
        Level 1 only: we check what the key your own frontend already ships to
        every visitor can see. The service-role key is refused — never paste it
        here.
      </p>
      {error && (
        <p role="alert" className="border border-line bg-surface px-4 py-3 text-sm text-sev-high">
          ▲ {error}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={pending} className={`${PRIMARY} disabled:opacity-60`}>
          {pending ? 'Checking…' : 'Connect project'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={pending}
          className="label text-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function ConnectionCard({ connection }: { connection: Connection }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<'scan' | 'revoke' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (error) void shake(buttonRef.current)
  }, [error])

  const lastScan = connection.lastScan

  async function runScan() {
    setBusy('scan')
    setError(null)
    try {
      const res = await fetch(`/api/connections/${connection.id}/scan`, { method: 'POST' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? 'Scan failed.')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  async function disconnect() {
    // Destructive: the sealed key is hard-deleted. One confirm is the
    // friction that stops a mis-click from discarding a working grant.
    if (!window.confirm(`Disconnect ${connection.externalAccount}? The stored key copy is destroyed.`)) {
      return
    }
    setBusy('revoke')
    setError(null)
    try {
      const res = await fetch(`/api/connections/${connection.id}`, { method: 'DELETE' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? 'Could not disconnect.')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-xl border border-c-line/60 bg-c-card p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium text-c-ink">{connection.externalAccount}</p>
          <p className="truncate text-[13px] text-c-muted">{connection.projectUrl}</p>
          <p className="mt-1 text-[12px] text-c-muted">
            Last scanned {stamp(connection.lastScannedAt)} · {lastScan ? `${lastScan.checksRun} checks` : 'not scanned yet'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            ref={buttonRef}
            type="button"
            onClick={runScan}
            data-press=""
            disabled={busy !== null || pending}
            className="rounded-full bg-c-ink px-5 py-2 text-[13px] font-medium text-c-brand-ink transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy === 'scan' ? 'Scanning…' : 'Scan now'}
          </button>
          <button
            type="button"
            onClick={disconnect}
            disabled={busy !== null || pending}
            className="rounded-full border border-c-line px-5 py-2 text-[13px] font-medium text-c-muted transition-colors hover:bg-c-soft hover:text-c-ink disabled:opacity-60"
          >
            {busy === 'revoke' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-[12px] text-sev-high">{error}</p>}

      {lastScan && (
        <div className="mt-4 border-t border-c-line/60 pt-4">
          {lastScan.findings.length === 0 ? (
            <p className="text-[13px] text-c-muted">
              No Level-1 findings. Everything the publishable key can reach checked out clean.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {lastScan.findings.map((finding) => (
                <li key={finding.checkId + finding.title} className="text-[13px] leading-relaxed">
                  <span className={`label mr-2 uppercase ${SEVERITY_TEXT[finding.severity] ?? 'text-c-muted'}`}>
                    {finding.severity}
                  </span>
                  <span className="text-c-ink">{finding.title}</span>
                </li>
              ))}
            </ul>
          )}
          {lastScan.errors.length > 0 && (
            <p className="mt-2 text-[12px] text-c-muted">
              {lastScan.errors.length} check{lastScan.errors.length === 1 ? '' : 's'} could not run.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function SupabaseConnections({ connections }: { connections: Connection[] }) {
  const [formOpen, setFormOpen] = useState(connections.length === 0)

  return (
    <div className="flex flex-col gap-4">
      {formOpen ? (
        <div className="rounded-xl border border-c-line/60 bg-c-card p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <ConnectForm onDone={() => setFormOpen(false)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="self-start rounded-full bg-c-soft px-4 py-1.5 text-[12px] font-medium text-c-muted transition-colors hover:bg-c-line hover:text-c-ink"
        >
          + Connect a Supabase project
        </button>
      )}

      {connections.map((connection) => (
        <ConnectionCard key={connection.id} connection={connection} />
      ))}
    </div>
  )
}
