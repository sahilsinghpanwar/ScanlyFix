/**
 * What the console's sidebar lists, and which of it actually exists.
 *
 * Most of these are NOT built. They are here because the shape of the product
 * is a decision worth showing early — someone looking at the sidebar should be
 * able to see where repositories and runtime protection are going to live —
 * and because a nav that grows an item at a time never gets designed as a
 * whole.
 *
 * The honesty is the point: an unbuilt item carries `soon: true`, and the
 * sidebar renders it as text with a badge rather than as a link. A nav item
 * that looks clickable and does nothing is the worst of the three options; a
 * nav item that says "Soon" is a roadmap.
 *
 * `live` items are the only ones with an href, so it is impossible to add a
 * destination here without also having a page at it.
 */

import type { IconName } from './icons.tsx'

export interface NavItem {
  label: string
  icon: IconName
  /** Present only when the page exists. */
  href?: string
  /** Not built yet — rendered as inert text with a badge. */
  soon?: boolean
  /** Which count, if any, this row shows. Resolved by the sidebar's props. */
  count?: 'sites' | 'scans'
}

export interface NavSection {
  /** Null for the first group, which needs no heading above the app's own name. */
  title: string | null
  items: NavItem[]
}

export const NAV: readonly NavSection[] = [
  {
    title: null,
    items: [
      { label: 'Dashboard', icon: 'home', href: '/dashboard' },
      { label: 'Feed', icon: 'feed', href: '/feed' },
      { label: 'AutoFix', icon: 'wrench', href: '/fixes' },
    ],
  },
  {
    title: 'Assets',
    items: [
      { label: 'Repositories', icon: 'repo', href: '/feed#repositories' },
      { label: 'Containers', icon: 'container', soon: true },
      { label: 'Clouds', icon: 'cloud', soon: true },
      /*
       * The one asset class that is real today: a project IS a domain under
       * watch, so this row carries the live count rather than a "Soon" badge.
       *
       * The fragment is load-bearing, not decoration. Domains live in a section
       * of the dashboard rather than on a route of their own, and the sidebar
       * marks a row active by comparing `href` to the pathname — so a bare
       * '/dashboard' here lit BOTH this row and Dashboard at once.
       */
      { label: 'Domains', icon: 'globe', href: '/dashboard#sites', count: 'sites' },
    ],
  },
  {
    title: 'Monitor',
    items: [
      { label: 'Live Threats', icon: 'threat', soon: true },
       { label: 'Uptime', icon: 'uptime', href: '/monitors' },
      { label: 'Monitoring', icon: 'bell', href: '/monitoring' },
    ],
  },
  {
    title: 'Protect',
    items: [{ label: 'Runtime', icon: 'shield', soon: true }],
  },
]
