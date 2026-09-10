/**
 * /sitemap.xml
 *
 * Only the two pages this product actually wants ranked. A sitemap is a
 * statement about what matters, not an inventory: padding it with every URL
 * that returns 200 spreads crawl budget across pages we then ask robots.txt
 * not to crawl, and the two contradict each other.
 *
 * Public status pages are left out on purpose even though they ARE crawlable
 * (Phase 6.4: per-project `robots_indexable` is honoured via a <meta> tag on
 * the page itself — the owner's opt-out is honoured whether or not we list
 * the page in the sitemap, and we never list it). They belong to customers,
 * they appear and disappear with those customers, and a sitemap that lists
 * them would go stale the first time somebody deletes a project. Search
 * engines find them from the links customers post, which is how they are
 * meant to be found.
 *
 * `lastModified` is the deploy time rather than a hardcoded date, because that
 * is what is true: these are static pages, so they change when the build does.
 */

import type { MetadataRoute } from 'next'
import { serverEnv } from '@/lib/env.ts'

function getSitemapBaseUrl(): string {
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

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSitemapBaseUrl()
  const lastModified = new Date()

  return [
    {
      url: base,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${base}/pricing`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    /*
     * Listed at a low priority rather than left out. Nobody searches for these,
     * but a payment processor's review looks for them and an unlisted page is
     * one more thing for a reviewer to fail to find.
     */
    {
      url: `${base}/about`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.5,
    },
    {
      url: `${base}/contact`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.5,
    },
    {
      url: `${base}/privacy`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${base}/terms`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ]
}
