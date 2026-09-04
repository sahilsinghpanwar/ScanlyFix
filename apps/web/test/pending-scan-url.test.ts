import { describe, expect, it } from 'vitest'
import {
  PENDING_URL_KEY,
  peekPendingUrl,
  shouldGateScan,
  stashPendingUrl,
  takePendingUrl,
  type KeyValueStore,
} from '@/components/scan/pending-scan-url.ts'

/** A Map-backed Storage, so a test can look at what was written. */
function fakeStore(initial: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

/** The store a private window hands back: present, but throws on every call. */
function throwingStore(): KeyValueStore {
  return {
    getItem() {
      throw new DOMException('denied', 'SecurityError')
    },
    setItem() {
      throw new DOMException('denied', 'SecurityError')
    },
    removeItem() {
      throw new DOMException('denied', 'SecurityError')
    },
  }
}

describe('stashPendingUrl', () => {
  it('writes the URL under the namespaced key', () => {
    const store = fakeStore()
    expect(stashPendingUrl(store, 'https://example.com')).toBe(true)
    expect(store.map.get(PENDING_URL_KEY)).toBe('https://example.com')
  })

  it('does nothing without a store', () => {
    expect(stashPendingUrl(null, 'https://example.com')).toBe(false)
  })

  it('refuses an empty URL, so a restore cannot report an empty box', () => {
    const store = fakeStore()
    expect(stashPendingUrl(store, '')).toBe(false)
    expect(store.map.size).toBe(0)
  })

  it('reports failure instead of throwing when the browser blocks storage', () => {
    expect(stashPendingUrl(throwingStore(), 'https://example.com')).toBe(false)
  })
})

describe('takePendingUrl', () => {
  it('returns the URL and clears it, so it is used exactly once', () => {
    const store = fakeStore({ [PENDING_URL_KEY]: 'https://example.com' })

    expect(takePendingUrl(store)).toBe('https://example.com')
    expect(store.map.has(PENDING_URL_KEY)).toBe(false)
    // The second form to mount, or the next visit to the page, must not be
    // handed an address the visitor has already moved past.
    expect(takePendingUrl(store)).toBeNull()
  })

  it('returns null when nothing was stashed', () => {
    expect(takePendingUrl(fakeStore())).toBeNull()
  })

  it('returns null without a store', () => {
    expect(takePendingUrl(null)).toBeNull()
  })

  it('treats an empty stored value as nothing to restore', () => {
    const store = fakeStore({ [PENDING_URL_KEY]: '' })
    expect(takePendingUrl(store)).toBeNull()
  })

  it('returns null instead of throwing when the browser blocks storage', () => {
    expect(takePendingUrl(throwingStore())).toBeNull()
  })

  it('round-trips what stashPendingUrl wrote', () => {
    const store = fakeStore()
    stashPendingUrl(store, 'https://scanlyfix.test/path?q=1')
    expect(takePendingUrl(store)).toBe('https://scanlyfix.test/path?q=1')
  })
})

describe('peekPendingUrl', () => {
  it('returns the URL without clearing it, so a refresh keeps the confirmation', () => {
    const store = fakeStore({ [PENDING_URL_KEY]: 'https://example.com' })

    expect(peekPendingUrl(store)).toBe('https://example.com')
    expect(store.map.get(PENDING_URL_KEY)).toBe('https://example.com')
    // The stash outlives the peek: only takePendingUrl consumes it.
    expect(peekPendingUrl(store)).toBe('https://example.com')
  })

  it('returns null when nothing was stashed', () => {
    expect(peekPendingUrl(fakeStore())).toBeNull()
  })

  it('returns null without a store', () => {
    expect(peekPendingUrl(null)).toBeNull()
  })

  it('treats an empty stored value as nothing to confirm', () => {
    const store = fakeStore({ [PENDING_URL_KEY]: '' })
    expect(peekPendingUrl(store)).toBeNull()
  })

  it('returns null instead of throwing when the browser blocks storage', () => {
    expect(peekPendingUrl(throwingStore())).toBeNull()
  })
})

describe('shouldGateScan', () => {
  it('gates a visitor who is known to be signed out', () => {
    expect(shouldGateScan({ authLoading: false, isAuthenticated: false })).toBe(true)
  })

  it('lets a signed-in visitor straight through', () => {
    expect(shouldGateScan({ authLoading: false, isAuthenticated: true })).toBe(false)
  })

  it('does not gate while the auth state is unknown', () => {
    // Both halves of "unknown": the pre-hydration render and Convex's own
    // loading state. Bouncing here would send a signed-in visitor to a login
    // page they do not need, and /api/scan decides for itself anyway.
    expect(shouldGateScan({ authLoading: true, isAuthenticated: false })).toBe(false)
    expect(shouldGateScan({ authLoading: true, isAuthenticated: true })).toBe(false)
  })
})
