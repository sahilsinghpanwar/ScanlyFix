/**
 * The sidebar's honesty rule, locked down.
 *
 * Most of the console's nav is not built. That is a deliberate product
 * statement, and it only stays honest while two things hold: an unbuilt row
 * has no destination, and a row with a destination is actually reachable. Get
 * either backwards and the nav ships a link that silently 404s — which is the
 * exact failure the `soon` flag exists to prevent.
 *
 * These are cheap assertions over a config object, which is the point: the
 * rule is enforced by the compiler-adjacent test rather than by whoever
 * remembers it while adding the next row.
 */

import { describe, expect, it } from 'vitest'
import { NAV } from '../components/console/nav.ts'

const items = NAV.flatMap((section) => section.items)

/** Routes that exist under app/. A row may only point at one of these. */
const REAL_ROUTES = new Set([
  '/dashboard',
  '/feed',
  '/fixes',
  '/settings/billing',
  '/settings/api-keys',
  '/scan/start',
  '/monitors',
  '/monitoring',
])

describe('console nav', () => {
  it('never gives an unbuilt row somewhere to go', () => {
    for (const item of items.filter((i) => i.soon)) {
      expect(item.href, `${item.label} is marked soon but carries an href`).toBeUndefined()
    }
  })

  it('only points at routes that exist', () => {
    for (const item of items.filter((i) => i.href)) {
      // A row may deep-link to a section with a fragment; the route is the part
      // before it, and that is what has to resolve.
      const route = item.href!.split('#')[0]
      expect(REAL_ROUTES.has(route!), `${item.label} points at ${item.href}`).toBe(true)
    }
  })

  it('gives every row a destination or a Soon badge, never neither', () => {
    for (const item of items) {
      expect(Boolean(item.href) !== Boolean(item.soon), `${item.label} is in both states or in neither`).toBe(
        true,
      )
    }
  })

  /*
   * The regression this locks: Domains and Dashboard both pointed at
   * '/dashboard', and the rail marks a row active by comparing href to the
   * pathname — so both rows lit up as the current page at once.
   */
  it('gives each linked row a distinct href, so only one can read as current', () => {
    const hrefs = items.filter((i) => i.href).map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('lists Dashboard first, because it is the only page that exists today', () => {
    expect(items[0]?.label).toBe('Dashboard')
    expect(items[0]?.href).toBe('/dashboard')
  })
})
