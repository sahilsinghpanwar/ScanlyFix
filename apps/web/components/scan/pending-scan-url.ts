/**
 * The URL a signed-out visitor typed, kept across the trip to /login.
 *
 * A visitor pastes a URL into the hero, presses Scan, and is sent to sign in.
 * The thing they typed has to survive that round trip — a full page navigation
 * to /login, then to the provider, then back through /callback and possibly
 * /welcome — or they come back to an empty box and have to type it again.
 * sessionStorage is the only store that spans those navigations, is scoped to
 * the one tab that is actually doing the signing in, and is emptied when the
 * tab closes.
 *
 * The logic lives here rather than in the hook because it is the part with
 * edge cases worth testing: a store that throws, a store that is not there,
 * and the read-once contract that stops a restored URL from reappearing on
 * every later visit to the page.
 */

/** The sessionStorage key. Namespaced so it cannot collide on a shared origin. */
export const PENDING_URL_KEY = 'scanlyfix:pending-scan-url'

/**
 * The slice of the Storage API this module uses.
 *
 * Narrowed to three methods so a test can pass a plain object, and so nothing
 * here can reach for `length` or `clear()` on a real user's storage.
 */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The browser's sessionStorage, or null when it cannot be used.
 *
 * Returns null on the server (no window) and when the browser refuses access
 * — Safari in Lockdown mode and any browser set to block site data throw on
 * the property access itself, not on the later call. A null store degrades to
 * "the URL is not carried across sign-in", which is worse than the happy path
 * and much better than a crash on the landing page.
 */
export function sessionStore(): KeyValueStore | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Remember a URL for after sign-in. Returns whether it was actually stored.
 *
 * Empty strings are refused: storing one would make `takePendingUrl` report a
 * restore that puts nothing in the box, and the caller would focus an input
 * for no reason.
 */
export function stashPendingUrl(store: KeyValueStore | null, url: string): boolean {
  if (!store || url === '') return false
  try {
    store.setItem(PENDING_URL_KEY, url)
    return true
  } catch {
    // Private windows and full quotas both throw here. Losing the URL costs
    // the visitor one retype; throwing would cost them the sign-in.
    return false
  }
}

/**
 * Read the remembered URL and forget it, in one step.
 *
 * Read-once on purpose. If the key survived the read, every later mount of a
 * scan form on this tab would refill itself with an address the visitor has
 * long since moved past — including after they scanned something else.
 */
export function takePendingUrl(store: KeyValueStore | null): string | null {
  if (!store) return null
  try {
    const url = store.getItem(PENDING_URL_KEY)
    if (url === null || url === '') return null
    store.removeItem(PENDING_URL_KEY)
    return url
  } catch {
    return null
  }
}

/**
 * Read the remembered URL without clearing it.
 *
 * For a page that shows the address and asks before acting on it — the
 * /scan/start confirmation. A refresh there must not lose the URL, so the
 * stash survives the read; `takePendingUrl` is what consumes it, and only
 * once the visitor has actually committed to the scan.
 */
export function peekPendingUrl(store: KeyValueStore | null): string | null {
  if (!store) return null
  try {
    const url = store.getItem(PENDING_URL_KEY)
    return url === null || url === '' ? null : url
  } catch {
    return null
  }
}

/**
 * Whether this submit has to go through sign-in first.
 *
 * Unknown auth is treated as signed IN: the gate is a convenience that saves a
 * round trip, and /api/scan re-decides for itself. Guessing "signed out" while
 * the state is still loading would bounce an already-signed-in visitor to a
 * login page they do not need.
 */
export function shouldGateScan(auth: { authLoading: boolean; isAuthenticated: boolean }): boolean {
  return !auth.authLoading && !auth.isAuthenticated
}
