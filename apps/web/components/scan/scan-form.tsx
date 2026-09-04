'use client'

import { useId, useRef } from 'react'
import { useScanSubmit } from './use-scan-submit.ts'
import { useSession } from '@/components/auth/supabase-context.ts'

/**
 * The standard scan form, used wherever the page is not the hero.
 *
 * Presentation only: everything that decides whether a scan starts lives in
 * useScanSubmit, which the hero's form calls too.
 *
 * `restore` is opt-in. On the landing page this form sits below the hero, which
 * already reclaims a URL left behind by a sign-in trip — two forms both taking
 * it would race for the one key. On the dashboard it is the only scan form, and
 * it is where a visitor now lands after signing in from a scan, so there it
 * opts in and reclaims the URL they typed before the detour.
 *
 * `tone` picks the skin, and nothing else. The product has two surfaces — the
 * square monospace terminal and the rounded console — and this form appears on
 * both. Keeping it one component with two class sets is what stops the two
 * copies from drifting on the part that matters, which is the submit logic.
 */
const TONES = {
  terminal: {
    label: 'block text-sm font-medium',
    field:
      'min-w-0 flex-1 border border-line bg-surface px-4 py-3 font-mono text-base text-ink ' +
      'placeholder:text-muted disabled:opacity-60',
    button: 'bg-accent px-6 py-3 text-base font-medium text-accent-ink disabled:opacity-60 sm:w-auto',
    error: 'mt-2 min-h-5 text-sm text-danger',
  },
  console: {
    label: 'block text-[13px] font-medium text-c-muted',
    field:
      'min-w-0 flex-1 rounded-lg border border-c-line bg-c-card px-4 py-2.5 text-[15px] text-c-ink ' +
      'placeholder:text-c-muted focus-visible:outline-2 focus-visible:outline-offset-1 ' +
      'focus-visible:outline-c-accent disabled:opacity-60',
    button:
      'rounded-lg bg-c-brand px-6 py-2.5 text-[14px] font-medium text-c-brand-ink ' +
      'transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto',
    error: 'mt-2 min-h-5 text-[13px] text-sev-high',
  },
} as const

export function ScanForm({
  restore = false,
  tone = 'terminal',
  stayAfterStart = false,
}: {
  restore?: boolean
  tone?: keyof typeof TONES
  /**
   * True on the dashboard: when the scan is accepted, re-render the page in
   * place so its latest-report section shows the loader and then the result.
   * False (default) navigates to the dashboard, so a scan started on the
   * landing page or the confirmation page shows its progress there too.
   */
  stayAfterStart?: boolean
} = {}) {
  const skin = TONES[tone]
  const inputId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const session = useSession()
  const { value, setValue, pending, error, submit } = useScanSubmit({
    restore,
    inputRef,
    afterStart: stayAfterStart ? 'refresh' : 'dashboard',
    authState: { isAuthenticated: session.data?.session?.user != null, isLoading: session.isLoading },
  })

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const started = await submit()
    if (!started) inputRef.current?.focus()
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full">
      <label htmlFor={inputId} className={skin.label}>
        Website address
      </label>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          ref={inputRef}
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="example.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={pending}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className={skin.field}
        />

        <button
          type="submit"
          disabled={pending}
          className={skin.button}
        >
          {pending ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {/* Announced to screen readers when it appears, not only when focused. */}
      <p id={errorId} role="alert" aria-live="polite" className={skin.error}>
        {error}
      </p>
    </form>
  )
}
