'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import {
  createProjectWithMonitors,
  findProjectByOwnerAndUrl,
  findRecentScanForUserAcrossProjects,
  getUserContext,
} from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { normalizeScanTarget } from '@/lib/url.ts'
import { clientIpHash } from '@/lib/request.ts'
import { checkApiScanAllowed, DEDUP_WINDOW_MS } from '@/lib/ratelimit.ts'
import { checkScanQuota } from '@/lib/quota.ts'
import { runScanJob } from '@/lib/scan/run-scan-job.ts'
import { entitlementsFor } from '@/lib/entitlements.ts'

/**
 * Starting a scan from a plain HTML form submission.
 *
 * ## Why this exists next to /api/scan
 *
 * The landing page's scan button was rendered `disabled` until React hydrated.
 * On a fast laptop that is invisible; on a mid-range phone over a slow
 * connection it is a second or more during which the one thing this page exists
 * to collect cannot be given. Somebody clicks, nothing happens, and they leave —
 * and the page it happens on is the one a stranger sees first.
 *
 * A React `onSubmit` handler cannot fix that, because there is no handler until
 * hydration. What fixes it is the form being a real form: with `action` set to
 * a Server Action, the browser submits natively before any JavaScript has run,
 * and React takes the same action over once it has. The submit path is
 * identical either way, so the two cannot drift.
 *
 * ## Why it does not just call /api/scan
 *
 * That route answers JSON to a caller that will read it. A form post has no
 * reader — the only thing it can do with an outcome is follow a redirect. So
 * this runs the same steps in the same order and ends in `redirect()` rather
 * than a response body.
 *
 * `deep` is deliberately absent. The no-JavaScript path is the fallback, and a
 * deep scan is the one that needs a client polling for progress.
 *
 * ## Why this also creates a project
 *
 * URL paste = scan + monitoring. The hero form's promise is that pasting your
 * domain starts watching it, not just scoring it once — so this action
 * bootstraps the project + four default monitors in the same call. The scan
 * is filed under that project id so the scan history and the dashboard's
 * Domains list agree from row 0.
 */

/** Where a rejected submission goes, with a sentence the page can render. */
function backToHero(reason: string): never {
  redirect(`/?scan_error=${encodeURIComponent(reason)}#scan`)
}

export async function startScanAction(formData: FormData): Promise<void> {
  const raw = formData.get('url')
  if (typeof raw !== 'string') backToHero('Enter a website address to scan.')

  // The same normalisation the client and the API route run. Three callers,
  // one definition of what a scannable address is.
  const target = normalizeScanTarget(raw)
  if (!target.ok) backToHero(target.reason)

  /*
   * The product rule the hero is built on: a scan needs an account, which
   * opens the worst findings (Pro opens them all). A signed-out visitor is sent
   * to sign in and comes back here.
   *
   * The URL they typed is NOT carried in this redirect. The enhanced path keeps
   * it in sessionStorage, which no server redirect can write; carrying it as a
   * query parameter instead would make this statically prerendered page read
   * searchParams, and turn the landing page dynamic for every visitor to serve
   * the few who arrive without JavaScript. Retyping an address is a smaller
   * cost than that.
   */
  const viewer = await getViewer()
  // Sign in, then land in the app — the dashboard, whose scan form is waiting —
  // not back on the marketing page. (%2Fdashboard is "/dashboard" encoded.)
  if (viewer.kind !== 'user') redirect('/login?next=%2Fdashboard')

  /*
   * Ensure the project + monitors BEFORE the dedup lookup. See the matching
   * block in app/api/scan/route.ts for the rationale — the short version is
   * that the dedup-hit path also needs a projectId so a re-paste navigates
   * to the domain the user is already watching, and that the quota check
   * comes AFTER so somebody out of scans is told THAT.
   */
  let projectId: string
  {
    const existing = await findProjectByOwnerAndUrl(viewer.userId, target.url)
    if (existing) {
      projectId = existing.id
    } else {
      const context = await getUserContext(viewer.userId)
      if (!context) backToHero('Account is not set up. Sign out and back in.')

      const { plan } = await entitlementsFor(viewer)
      const created = await createProjectWithMonitors(
        viewer,
        { name: target.hostname, url: target.url, orgId: context.orgId },
        plan.projects,
      )
      if (!created.ok) {
        if (created.reason === 'limit-reached') {
          backToHero(
            `The ${plan.name} plan includes ${plan.projects} ` +
              `${plan.projects === 1 ? 'project' : 'projects'}. Upgrade to track more sites.`,
          )
        }
        backToHero('Could not create the project for this site.')
      }
      projectId = created.project.id
    }
  }

  // Already answered recently by this account: reuse it rather than fetch the
  // target twice. Spans scans filed under the user's projects AND ad-hoc
  // scans, so a re-paste of a watched URL still hits the cache.
  const cached = await findRecentScanForUserAcrossProjects(
    target.url,
    'fast',
    viewer.userId,
    new Date(Date.now() - DEDUP_WINDOW_MS),
  )
  if (cached) {
    const destination = cached.projectId
      ? `/projects/${cached.projectId}`
      : `/projects/${projectId}`
    redirect(destination)
  }

  const quota = await checkScanQuota(viewer)
  if (!quota.ok) backToHero(quota.reason)

  // By account, not by IP — see the note in app/api/scan/route.ts.
  const anonIpHash = clientIpHash(await headers())
  const verdict = await checkApiScanAllowed({ userId: viewer.userId, targetHost: target.hostname })
  if (!verdict.ok) backToHero(verdict.reason)

  let scanId: string
  try {
    scanId = await runScanJob({
      url: target.url,
      profile: 'fast',
      anonIpHash,
      projectId,
      requestedBy: viewer.userId,
    })
  } catch (error) {
    // runScanJob records a failed scan itself and still returns an id, so
    // reaching here means something below it broke.
    console.error('[scan-action] could not record the scan', error)
    backToHero('Could not start the scan. Please try again in a moment.')
  }

  // Land on the project page: that is where the scan's loader and result will
  // surface, and the place that opens uptime / domain / SSL in one click.
  // Falls back to /scan/[id] only when no project was created (which would
  // itself be a bug, since ensureProject ran above — but the redirect must
  // never produce an undefined path).
  redirect(`/projects/${projectId}`)
}
