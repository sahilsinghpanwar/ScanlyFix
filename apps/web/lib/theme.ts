/**
 * The theme preference: what the user chose, and what that resolves to.
 *
 * Three states, Vercel-style. `light` and `dark` are explicit and win over the
 * OS. `system` (also the default when nothing has ever been chosen) follows
 * `prefers-color-scheme`. The resolution itself is pure so the tests can cover
 * every combination; the browser side effects live in two small functions
 * guarded by `typeof window`, so importing this module on the server is safe.
 *
 * The chosen state is persisted under one localStorage key. The actual colour
 * flip happens in CSS through the `dark`/`light` classes on <html> — React
 * never re-renders for a theme change, which is what keeps the flip instant.
 *
 * ## The init script
 *
 * `themeInitScript` is inlined into <head> by the root layout and runs BEFORE
 * first paint: it applies the resolved class immediately, so a dark-mode
 * visitor never sees a white flash (FOUC). It duplicates the tiny resolve rule
 * below because an inline script cannot import a module — the test for it
 * executes it against a stubbed browser and asserts the classes it sets, so
 * the two cannot silently drift apart.
 *
 * ## Why a class and not only the media query
 *
 * Without an explicit choice the class is still set from the OS setting, so
 * Tailwind's `dark:` variant (wired to the class in globals.css) tracks the
 * system everywhere — including the pages this preference was never opened on.
 */

export const THEME_KEY = 'scanlyfix-theme'

export type ThemePreference = 'light' | 'system' | 'dark'

export type ResolvedTheme = 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'system', 'dark']

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'system' || value === 'dark'
}

/** An explicit light/dark wins; system (or anything unreadable) follows the OS. */
export function resolveTheme(
  preference: ThemePreference | null,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

/** Reads the stored preference, tolerating a missing storage or a corrupt value. */
export function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = window.localStorage.getItem(THEME_KEY)
    return isThemePreference(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

export function storePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_KEY, preference)
  } catch {
    // Private mode or a full quota: the choice just does not survive a reload.
  }
}

/**
 * Applies the resolved classes to <html>. Idempotent and complete — it removes
 * both classes first, so a stale class from a previous preference can never
 * survive next to the new one.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(
    preference,
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  )
  if (typeof document === 'undefined') return resolved
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(resolved)
  return resolved
}

/**
 * The function to listen to while in system mode: when the OS flips and the
 * user has not made an explicit choice, the class has to follow, because the
 * CSS media-query fallback cannot apply once a class is present.
 */
export function systemDarkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-color-scheme: dark)')
}

/** Inlined into <head> before first paint — see the module note above. */
export const themeInitScript = `(function(){try{
var p=localStorage.getItem('${THEME_KEY}');
if(p!=='light'&&p!=='dark'&&p!=='system')p='system';
var m=window.matchMedia('(prefers-color-scheme: dark)');
var d=p==='dark'||(p==='system'&&m.matches);
var c=document.documentElement.classList;
c.remove('light','dark');c.add(d?'dark':'light');
}catch(e){}})()`
