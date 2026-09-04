/**
 * POST /api/scan — the endpoint the landing page's form talks to.
 *
 * Deliberately thin. It validates, throttles, and delegates; the scan itself
 * lives in lib/scan/run-scan-job.ts so that moving it onto a queue later is a
 * change of caller rather than a rewrite of this file.
 *
 * The order of the steps is load-bearing:
 *
 *   1. normalize   — re-run on the server, because the client already did and
 *                    the client is not trusted.
 *   2. ensure signed-in — a scan needs an account, so a signed-out caller is
 *                    bounced to /login before any work runs.
 *   3. ensure project — the URL is also watched: a paste is now both a scan
 *                    and the start of uptime/SSL/domain monitoring on this
 *                    domain, so the project row + four default monitors are
 *                    created (or looked up) before the scan starts. Skipping
 *                    this would leave the dashboard empty for paste-driven
 *                    users — the gap that drove this change.
 *   4. dedup       — a recent scan of the same URL by the same user is
 *                    reused. The window now spans both ad-hoc and
 *                    project-filed scans, so a re-paste of an already-watched
 *                    URL still returns the cached scan id and skips the fetch.
 *   5. quota       — the account's monthly allowance. Before the rate limit
 *                    so that somebody who is out of scans is told THAT,
 *                    rather than a sentence about the last hour that does not
 *                    explain why tomorrow will not help either.
 *   6. rate limit  — abuse protection, which protects the TARGET rather than
 *                    us, and therefore applies to everyone including paying
 *                    accounts.
 *   7. run         — the only step that touches somebody else's server. The
 *                    scan row is filed under the project from the start, so
 *                    the dashboard's Domains list, scan history, and the
 *                    monitor components all agree on the same id.
 *
 * A signed-in scan is attributed with `requestedBy`. Without that a logged-in
 * person scanning from the landing page produced an anonymous scan: it never
 * appeared in their history and never counted against their plan.
 */

import { NextResponse } from 'next/server'
import {
  createProjectWithMonitors,
  findProjectByOwnerAndUrl,
  findRecentScanForUserAcrossProjects,
  getUserContext,
  type ScanProfile,
} from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { inngest, EVENTS } from '@/lib/inngest.ts'
import { checkScanQuota } from '@/lib/quota.ts'
import { normalizeScanTarget } from '@/lib/url.ts'
import { assertServerEnv } from '@/lib/env.ts'
import { clientIpHash } from '@/lib/request.ts'
import { checkApiScanAllowed, DEDUP_WINDOW_MS } from '@/lib/ratelimit.ts'
import { runScanJob, startScanJob } from '@/lib/scan/run-scan-job.ts'
import { entitlementsFor } from '@/lib/entitlements.ts'

/** The engine uses node:dns, node:net and node:tls; it cannot run on the edge. */
export const runtime = 'nodejs'

/**
 * Measured scan times today are 90ms to 2.2s. The ceiling is for a slow target
 * that exhausts its probe budget — not the expected case, but the one that
 * would otherwise be killed mid-write and leave a scan stuck in 'running'.
 */
export const maxDuration = 60

interface ScanBody {
  url?: unknown
  profile?: unknown
}

interface ScanResponse {
  scanId: string
  /** Present whenever the URL was filed under a project this request created or reused. */
  projectId?: string
  /** True when a recent scan of this URL was reused instead of run again. */
  cached?: boolean
  /** True for a deep scan the queue will pick up after the response. */
  queued?: boolean
}

const PROFILES: readonly ScanProfile[] = ['fast', 'deep']

function isProfile(value: unknown): value is ScanProfile {
  return typeof value === 'string' && PROFILES.includes(value as ScanProfile)
}

function fail(error: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ error }, { status, headers })
}

/**
 * Resolve the project this URL paste should be filed under, creating it (with
 * its four default monitors) if no row exists for this user + URL.
 *
 * Returns `null` when the plan ceiling stops us: the caller surfaces the same
 * sentence the dashboard's "Add domain" form does, so a paste and a manual add
 * agree on what the limit means.
 *
 * Called BEFORE the dedup lookup so the cached-scan path also has a projectId
 * to send back to the client — otherwise a re-paste would not navigate the
 * user to the domain they're already watching.
 */
async function ensureProjectFor(
  viewer: { kind: 'user'; userId: string },
  url: string,
): Promise<{ ok: true; projectId: string } | { ok: false; reason: string }> {
  const existing = await findProjectByOwnerAndUrl(viewer.userId, url)
  if (existing) return { ok: true, projectId: existing.id }

  const context = await getUserContext(viewer.userId)
  if (!context) {
    // ensureUser runs at sign-in and creates a personal org + subscription.
    // A miss here is a row deleted mid-request — the same answer authz.ts
    // gives for it.
    return { ok: false, reason: 'Account is not set up. Sign out and back in.' }
  }

  const { plan } = await entitlementsFor(viewer)
  const result = await createProjectWithMonitors(
    viewer,
    { name: new URL(url).hostname, url, orgId: context.orgId },
    plan.projects,
  )

  if (!result.ok) {
    if (result.reason === 'limit-reached') {
      return {
        ok: false,
        reason:
          `The ${plan.name} plan includes ${plan.projects} ` +
          `${plan.projects === 1 ? 'project' : 'projects'}. Upgrade to track more sites.`,
      }
    }
    return { ok: false, reason: 'Could not create the project for this site.' }
  }
  return { ok: true, projectId: result.project.id }
}

export async function POST(request: Request) {
  try {
    assertServerEnv()
  } catch (error) {
    console.error('[api/scan] environment is not configured', error)
    return fail('The scanner is not configured correctly. This is a problem on our side.', 500)
  }

  let body: ScanBody
  try {
    body = (await request.json()) as ScanBody
  } catch {
    return fail('Expected a JSON body containing a url.', 400)
  }

  if (typeof body.url !== 'string') {
    return fail('Expected a JSON body containing a url.', 400)
  }

  const target = normalizeScanTarget(body.url)
  if (!target.ok) return fail(target.reason, 400)

  // Absent means fast. An unrecognised value is rejected rather than coerced:
  // silently downgrading a caller who asked for depth would give them a report
  // missing the very checks they asked for, with nothing to say why.
  const profile: ScanProfile = body.profile === undefined ? 'fast' : (body.profile as ScanProfile)
  if (!isProfile(profile)) return fail(`Unknown scan profile. Use one of: ${PROFILES.join(', ')}.`, 400)

  /*
   * A scan requires an account, and the check sits BEFORE the dedup cache on
   * purpose: a cached result handed to a signed-out caller is still a scan they
   * got without signing in. The 401 is the server's half of the landing page's
   * gate — the browser also redirects a signed-out visitor to /login, but the
   * cookie is the only thing that cannot be faked by a stale client token, so
   * this is where "signing in is required to scan" is actually enforced.
   *
   * The client turns this status into a trip to /login, not an error message.
   */
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return fail('Sign in to run a scan. It takes a moment and keeps your reports.', 401)
  }

  /*
   * Ensure the project + monitors BEFORE the dedup lookup.
   *
   * Order matters in two ways. Running it before dedup means the dedup-hit
   * path also has a projectId to send back — without that, a re-paste of a
   * watched domain would not navigate the user to the project page. Running
   * it before the quota check means somebody who is out of scans is told
   * THAT, and we do not silently create a project they cannot scan for.
   */
  const ensured = await ensureProjectFor(viewer, target.url)
  if (!ensured.ok) {
    // limit-reached reads naturally as a scan-side message because the user
    // asked us to scan a URL — they only learn the scan side-effect created
    // a project through the sentence's wording. account-setup errors become
    // 400 here because the request itself is well-formed; the failure is
    // about the account, not the URL.
    return fail(ensured.reason, 400)
  }
  const projectId = ensured.projectId

  /*
   * A hit here means this account already asked this exact question recently.
   * Reusing its own answer protects the target, the account's quota, and
   * their patience. The lookup spans scans filed under any of the user's
   * projects AND ad-hoc scans, so a re-paste of a watched URL still hits
   * the cache and does not create a second copy of the same scan.
   *
   * Auth: the join filters by `projects.ownerId = userId`, so a scan filed
   * under somebody else's project never matches — and cannot leak its id
   * to a stranger guessing URLs.
   */
  const cached = await findRecentScanForUserAcrossProjects(
    target.url,
    profile,
    viewer.userId,
    new Date(Date.now() - DEDUP_WINDOW_MS),
  )
  if (cached) {
    return NextResponse.json({
      scanId: cached.id,
      projectId: cached.projectId ?? projectId,
      cached: true,
    })
  }

  const quota = await checkScanQuota(viewer)
  if (!quota.ok) return fail(quota.reason, 429)

  /*
   * Rate-limited by ACCOUNT, not by IP. Scanning requires a signed-in user now,
   * so the account is the thing to meter — a per-IP cap would throttle everyone
   * behind one office or VPN as if they were a single abuser, and five scans an
   * hour is far too tight for a real customer. The per-target limit inside this
   * check still protects the site being scanned.
   */
  const anonIpHash = clientIpHash(request.headers)
  const verdict = await checkApiScanAllowed({ userId: viewer.userId, targetHost: target.hostname })
  if (!verdict.ok) {
    return fail(verdict.reason, 429, { 'retry-after': String(verdict.retryAfterSeconds) })
  }

  const job = {
    url: target.url,
    profile,
    anonIpHash,
    // The scan is filed under the project from row 0, so the project's scan
    // history and the dashboard's Domains row agree on the same scan id the
    // moment the worker finishes. completeScan's auto-enable of the rescan
    // monitor also keys off this projectId (see queries/scans.ts).
    projectId,
    requestedBy: viewer.userId,
  }

  const response: ScanResponse = { scanId: '', projectId }
  try {
    /*
     * A fast scan finishes in about two seconds, so the request waits for it
     * and the caller gets a finished report. A deep one cannot: the row is
     * reserved, the id comes back immediately, and the client polls
     * /api/scan/[scanId]/status while the queue does the work.
     */
    if (profile === 'deep') {
      response.scanId = await startScanJob(job)
      await inngest.send({ name: EVENTS.scanRequested, data: { scanId: response.scanId, ...job } })
      response.queued = true
      return NextResponse.json(response)
    }

    response.scanId = await runScanJob(job)
    return NextResponse.json(response)
  } catch (error) {
    // runScanJob records a failed SCAN itself and still returns an id, so
    // reaching here means something below it broke — the database, most
    // likely. The visitor gets a sentence; the detail goes to the log.
    console.error('[api/scan] could not record the scan', error)
    return fail('Could not start the scan. Please try again in a moment.', 500)
  }
}
