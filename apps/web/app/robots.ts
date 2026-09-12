/**
 * /robots.txt
 *
 * A product that sells an SEO audit and ships without a robots.txt fails its
 * own check on its own domain, so this file is not optional here the way it is
 * elsewhere.
 *
 * Public pages that are allowed:
 *   - / — landing page
 *   - /pricing — conversion page
 *   - /about — company / product info
 *   - /contact — support contact
 *   - /privacy — privacy policy (required by payment processors)
 *   - /terms — terms of service (required by payment processors)
 *   - /status/<slug> — public status pages, crawlable by design (Phase 6.4:
 *     per-page robots meta tag is owner-controlled — see docs/status-page.md)
 *
 * Two kinds of page are deliberately excluded:
 *
 *   - The signed-in app. Every one of these redirects a crawler to /login, so
 *     indexing them spends crawl budget to produce nothing.
 *   - /scan/<id>. These are shareable by link on purpose, and must stay that
 *     way — Disallow controls crawling, not access. But each one is a page
 *     about somebody ELSE's website, and letting search engines index
 *     thousands of them puts other companies' security and SEO problems into
 *     public results under our domain. That is a liability to them and, to us,
 *     a mass of near-duplicate thin pages that drags the domain down.
 *
 * Note on the per-page noindex (Phase 6.4): an owner can opt their status
 * page out of indexing via `projects.robots_indexable`. The page emits a
 * <meta name="robots" content="noindex, nofollow"> tag, which we honour
 * here by NOT excluding the path globally — the owner's choice is
 * expressed via the meta tag, not via robots.txt. A per-project robots.txt
 * rule is a future improvement; today the global Allow is the right
 * default because indexability is the product's default.
 */

import type { MetadataRoute } from 'next'
import { serverEnv } from '@/lib/env.ts'

/** Everything a crawler gains nothing from, or should not be republishing. */
const PRIVATE_PATHS = [
  '/api/',
  '/dashboard',
  '/settings/',
  '/projects/',
  '/welcome',
  '/callback',
  '/login',
  '/scan/',
]

function getRobotsBaseUrl(): string {
  try {
    return serverEnv.appUrl
  } catch {
    const raw =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
      'https://scanlyfix.com'
    return raw.replace(/\/+$/, '')
  }
}

export default function robots(): MetadataRoute.Robots {
  const base = getRobotsBaseUrl()

  return {
    rules: [{ userAgent: '*', allow: '/', disallow: PRIVATE_PATHS }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  }
}
