'use client'

import { useCallback, useEffect, useState } from 'react'
import { Icon } from './icons.tsx'
import {
  applyTheme,
  readStoredPreference,
  storePreference,
  systemDarkQuery,
  THEME_KEY,
  type ThemePreference,
} from '@/lib/theme.ts'

/**
 * The dashboard's theme switch: Light · System · Dark, Vercel-style.
 *
 * Self-contained on purpose. It writes the preference to localStorage and
 * flips the class on <html> directly — the actual colours move in CSS, so no
 * React re-render and no re-fetch is involved in a theme change. State stays
 * honest across places that could disagree:
 *
 * - `storage` events sync every other tab after a choice is made in one.
 * - while in `system`, a `matchMedia` listener re-applies when the OS itself
 *   flips, because the CSS media-query fallback cannot apply once a class is
 *   present.
 *
 * The server render always draws `system` as active; the choice is read in an
 * effect after hydration. That is the one honest way to render localStorage
 * without a hydration mismatch — the control is a small icon strip, so the
 * one-frame settle is invisible. The component never renders before the inline
 * init script has already themed the page, so the settle is only about which
 * segment is highlighted, never about the colours.
 */

const OPTIONS: readonly { value: ThemePreference; icon: 'sun' | 'monitor' | 'moon'; label: string }[] =
  [
    { value: 'light', icon: 'sun', label: 'Light' },
    { value: 'system', icon: 'monitor', label: 'System' },
    { value: 'dark', icon: 'moon', label: 'Dark' },
  ]

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference>('system')

  useEffect(() => {
    setPreference(readStoredPreference())

    // Another tab picked a theme; follow it instead of fighting it.
    function onStorage(event: StorageEvent) {
      if (event.key === THEME_KEY) setPreference(readStoredPreference())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // System mode has to keep following the OS. Explicit modes deliberately do
  // not: the user overruled the OS, and the overrule stands until they reopen.
  useEffect(() => {
    if (preference !== 'system') return
    const query = systemDarkQuery()
    if (!query) return
    function onSystemChange() {
      applyTheme('system')
    }
    query.addEventListener('change', onSystemChange)
    return () => query.removeEventListener('change', onSystemChange)
  }, [preference])

  const choose = useCallback((next: ThemePreference) => {
    setPreference(next)
    storePreference(next)
    applyTheme(next)
  }, [])

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={`flex items-center gap-0.5 rounded-lg border border-c-line bg-c-card p-0.5 ${className}`}
    >
      {OPTIONS.map((option) => {
        const active = option.value === preference
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.label}
            onClick={() => choose(option.value)}
            className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
              active
                ? 'bg-c-soft text-c-ink'
                : 'text-c-muted hover:text-c-ink hover:bg-c-soft/60'
            }`}
          >
            <Icon name={option.icon} size={15} />
            <span className="sr-only">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
