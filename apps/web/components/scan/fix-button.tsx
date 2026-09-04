'use client'

/**
 * The Fix button: one finding in, one work order out.
 *
 * Clicking asks the backend (which asks the fix tier, which asks the model)
 * for a prompt that fixes this specific finding. The prompt arrives revealed
 * and copyable. When generation fails transiently — the free model tier
 * throttles, hiccups, times out — the button becomes a retry, because trying
 * again is exactly what failed and nothing else. A paywall answer (403) or an
 * unconfigured deployment is NOT retryable: no amount of retrying changes it,
 * so those render as a sentence instead.
 *
 * Why the prompt is not on the page already: it is written per request by the
 * model against the finding's evidence, which is the difference between a
 * template that says "set a CSP header" and a work order that quotes the
 * observed headers and names the verification step.
 */

import { useState } from 'react'
import { CopyButton } from './copy-button.tsx'

type FixState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; prompt: string }
  | { kind: 'error'; message: string; retryable: boolean }

export function FixButton({ scanId, checkId }: { scanId: string; checkId: string }) {
  const [state, setState] = useState<FixState>({ kind: 'idle' })

  async function generate() {
    if (state.kind === 'loading') return
    setState({ kind: 'loading' })

    try {
      const response = await fetch('/api/fix', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scanId, checkId }),
      })

      const body: unknown = await response.json().catch(() => null)

      if (response.ok && body && typeof body === 'object' && 'prompt' in body) {
        const prompt = (body as { prompt: unknown }).prompt
        if (typeof prompt === 'string' && prompt.trim() !== '') {
          setState({ kind: 'done', prompt })
          return
        }
      }

      const detail =
        body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `Could not write the fix (HTTP ${response.status}).`
      const retryable =
        body && typeof body === 'object' && 'retryable' in body && (body as { retryable: unknown }).retryable === true
      setState({ kind: 'error', message: detail, retryable: retryable === true || response.status >= 500 })
    } catch {
      setState({ kind: 'error', message: 'Could not reach the fix writer. Check your connection and try again.', retryable: true })
    }
  }

  if (state.kind === 'done') {
    return (
      <div className="mt-3">
        <p className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted">Fix prompt</p>
        <pre className="whitespace-pre-wrap break-words border border-line bg-surface p-3 font-mono text-sm leading-relaxed text-ink">
          {state.prompt}
        </pre>
        <div className="mt-2 flex flex-wrap gap-2">
          <CopyButton text={state.prompt} />
          <button
            type="button"
            onClick={() => void generate()}
            className="border border-line px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            Write it again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3" aria-live="polite">
      {state.kind === 'error' && (
        <p role="alert" className="mb-2 text-sm leading-relaxed text-danger">
          {state.message}
        </p>
      )}
      <button
        type="button"
        onClick={() => void generate()}
        disabled={state.kind === 'loading'}
        className="inline-flex items-center gap-1.5 border border-accent bg-accent-soft px-3 py-1.5 text-xs font-semibold
                   text-accent-ink transition-colors hover:bg-accent hover:text-accent-ink disabled:opacity-60"
      >
        {state.kind === 'loading' && (
          <span
            aria-hidden="true"
            className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
          />
        )}
        {state.kind === 'loading' ? 'Writing fix…' : state.kind === 'error' ? 'Retry' : 'Fix this'}
      </button>
    </div>
  )
}
