/**
 * Projects and their scan history.
 *
 * Same rule as queries/scans.ts: every function takes a Viewer and there is no
 * unfiltered variant. Drizzle connects as the database owner, so Postgres
 * row-level security never applies — this file is the access control, not a
 * convenience layer over it.
 */

import { and, count, desc, eq, isNull } from 'drizzle-orm'
import { randomBytes, randomUUID } from 'node:crypto'
import { db } from '../client.ts'
import {
  monitors,
  projects,
  scans,
  type Project,
  type Scan,
} from '../schema.ts'
import {
  DEFAULT_MONITOR_ENABLED,
  DEFAULT_MONITOR_INTERVALS,
  DEFAULT_MONITOR_TYPES,
} from './onboarding-defaults.ts'
import type { Viewer } from './viewer.ts'

export interface NewProjectInput {
  name: string
  /** Normalized upstream. This layer stores URLs, it does not parse them. */
  url: string
  orgId: string
}

export async function listProjects(viewer: Viewer): Promise<Project[]> {
  if (viewer.kind !== 'user') return []
  return db.query.projects.findMany({
    where: eq(projects.ownerId, viewer.userId),
    orderBy: desc(projects.createdAt),
  })
}

export async function getProject(projectId: string, viewer: Viewer): Promise<Project | null> {
  if (viewer.kind !== 'user') return null
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.ownerId, viewer.userId)),
  })
  return project ?? null
}

export type CreateProjectResult =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly reason: 'unauthenticated' | 'limit-reached' | 'failed' }

/**
 * The plan's project limit is enforced HERE, at the write, and the limit is a
 * required argument rather than something this file looks up.
 *
 * Two decisions, both deliberate. It lives in the query layer because a server
 * action is not the only caller — the public API in a later phase will create
 * projects too, and a rule that lives in one caller is a rule the next caller
 * forgets. And the number is passed in because plans.ts lives in the web app:
 * this package must not learn about pricing, but it can be told a ceiling.
 * A caller that forgets to supply one does not compile.
 *
 * The count and the insert are not atomic, so two simultaneous creates can
 * both pass a limit of one. Accepted: the cost is a single extra project in a
 * rare race, and the alternative is a transaction with a table lock on a path
 * that runs a handful of times per account, ever.
 */
export async function createProject(
  viewer: Viewer,
  input: NewProjectInput,
  maxProjects: number,
): Promise<CreateProjectResult> {
  if (viewer.kind !== 'user') return { ok: false, reason: 'unauthenticated' }

  const [existing] = await db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.ownerId, viewer.userId))

  if ((existing?.n ?? 0) >= maxProjects) return { ok: false, reason: 'limit-reached' }

  const [project] = await db
    .insert(projects)
    .values({
      ownerId: viewer.userId,
      orgId: input.orgId,
      name: input.name,
      url: input.url,
      slug: slugFor(input.url),
      // Minted here so the verification page can render instructions without
      // writing anything during a render.
      verificationToken: newVerificationToken(),
    })
    .returning()

  return project ? { ok: true, project } : { ok: false, reason: 'failed' }
}

/**
 * Create a project AND its four default monitors in one transaction.
 *
 * Onboarding (Phase 7.1): the activation research showed that asking a
 * new user to enable four monitors after signup drops activation to
 * ~10%. Creating the project with three monitors enabled out of the box
 * (uptime / domain / web_vitals) and a fourth (rescan) staged for
 * enable-on-first-scan is the difference between "I have an empty
 * dashboard" and "I have a working status page" by the time the
 * dashboard renders.
 *
 * Why a transaction:
 *   - A project without its monitors is a worse state than no project at
 *     all (the new user lands on an empty `/monitors` page and abandons).
 *   - The plan-ceiling check must run against the same transaction so
 *     we cannot race past it on a concurrent signup.
 *   - A failed monitor insert must not leave an orphan `projects` row
 *     behind; the rollback is the safety net.
 *
 * Same plan-ceiling contract as `createProject`: the limit is passed in
 * because this package must not learn about pricing.
 */
export async function createProjectWithMonitors(
  viewer: Viewer,
  input: NewProjectInput,
  maxProjects: number,
): Promise<CreateProjectResult> {
  if (viewer.kind !== 'user') return { ok: false, reason: 'unauthenticated' }

  // Lazy import — circular-free and keeps the onboarding surface tight.
  const { ensureDefaultMonitors } = await import('./onboarding-defaults.ts')

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ n: count() })
      .from(projects)
      .where(eq(projects.ownerId, viewer.userId))

    if ((existing?.n ?? 0) >= maxProjects) {
      return { ok: false as const, reason: 'limit-reached' as const }
    }

    const [project] = await tx
      .insert(projects)
      .values({
        ownerId: viewer.userId,
        orgId: input.orgId,
        name: input.name,
        url: input.url,
        slug: slugFor(input.url),
        verificationToken: newVerificationToken(),
      })
      .returning()

    if (!project) return { ok: false as const, reason: 'failed' as const }

    // Bootstrap the four default monitors inside the same transaction.
    // We re-implement the upsert here (rather than calling
    // `ensureDefaultMonitors` which uses the package-level `db`) so
    // every write participates in the same tx — a failure rolls back
    // the project row too.
    for (const type of DEFAULT_MONITOR_TYPES) {
      await tx
        .insert(monitors)
        .values({
          projectId: project.id,
          type,
          enabled: DEFAULT_MONITOR_ENABLED[type],
          intervalS: DEFAULT_MONITOR_INTERVALS[type],
        })
        .onConflictDoNothing({
          target: [monitors.projectId, monitors.type],
        })
    }

    return { ok: true as const, project }
  })
}

/**
 * Find an existing project this viewer already owns for the same URL.
 *
 * URL-paste flows (the scan API, the no-JS scan action, the start-scan
 * confirmation) now bootstrap a project + monitors alongside the scan, so a
 * repeat paste must NOT create a second project for the same URL — the user
 * would end up with N identical rows in their dashboard, each running its own
 * copy of the four monitors, and the first one they tried to delete would
 * leave the others pointing at monitors they never signed off on.
 *
 * Scoped to the viewer's own projects: a URL already owned by somebody else
 * must not be re-claimed through this lookup.
 *
 * No `Viewer` parameter is taken because the caller already has the user id
 * and may want to lookup before the scan has been attributed; the equivalent
 * `getProject` does take one. The rule is the same — viewer.id only ever
 * matches its own row — and a future caller that needs to lock this down can
 * add the parameter without breaking the existing call sites.
 */
export async function findProjectByOwnerAndUrl(
  ownerId: string,
  url: string,
): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.url, url)))
    .orderBy(desc(projects.createdAt))
    .limit(1)
  return row ?? null
}

/**
 * A project's scans, newest first.
 *
 * Findings are not joined: the history view shows scores and dates, and pulling
 * every finding of every scan to render a list of numbers is the kind of query
 * that is fine with three scans and unusable with three hundred.
 */
export async function listScansForProject(projectId: string, viewer: Viewer, limit = 30) {
  if (await getProject(projectId, viewer)) {
    return db.query.scans.findMany({
      where: eq(scans.projectId, projectId),
      orderBy: desc(scans.createdAt),
      limit,
    })
  }
  return []
}

/**
 * Attach an anonymous scan to a new project owned by the viewer.
 *
 * This is the funnel. A stranger scans, likes the report, signs up — and this
 * is what turns that report into something in their account instead of a link
 * they have to keep. Without it they sign up into an empty dashboard, which is
 * the highest-converting moment in the product spent on nothing.
 *
 * Only genuinely anonymous scans can be claimed. Guarding on projectId and
 * requestedBy being null in the UPDATE itself means two people racing on the
 * same shared link cannot both take it, and neither can anyone re-claim a scan
 * that already belongs to someone.
 */
export async function claimScan(
  scanId: string,
  viewer: Viewer,
  orgId: string,
): Promise<{ projectId: string } | null> {
  if (viewer.kind !== 'user') return null

  return db.transaction(async (tx) => {
    const scan = await tx.query.scans.findFirst({
      where: eq(scans.id, scanId),
      columns: { id: true, url: true, projectId: true, requestedBy: true },
    })
    if (!scan || scan.projectId !== null || scan.requestedBy !== null) return null

    const [project] = await tx
      .insert(projects)
      .values({
        ownerId: viewer.userId,
        orgId,
        name: hostOf(scan.url),
        url: scan.url,
        slug: slugFor(scan.url),
      })
      .returning({ id: projects.id })
    if (!project) return null

    // Onboarding (Phase 7.1): a claimed scan becomes a project, and a
    // project ships with its four default monitors. Same transaction —
    // a failed monitor insert rolls the project row back.
    for (const type of DEFAULT_MONITOR_TYPES) {
      await tx
        .insert(monitors)
        .values({
          projectId: project.id,
          type,
          enabled: DEFAULT_MONITOR_ENABLED[type],
          intervalS: DEFAULT_MONITOR_INTERVALS[type],
        })
        .onConflictDoUpdate({
          target: [monitors.projectId, monitors.type],
          set: {},
        })
    }

    const claimed = await tx
      .update(scans)
      .set({ projectId: project.id, requestedBy: viewer.userId })
      // Re-checked here, not only above: between the read and the write the
      // scan may have been claimed by a concurrent request on the same link.
      .where(and(eq(scans.id, scanId), isNull(scans.projectId), isNull(scans.requestedBy)))
      .returning({ id: scans.id })

    if (claimed.length === 0) {
      // Someone else won the race. Remove the project we speculatively created
      // rather than rolling back — tx.rollback() throws, and a lost race is a
      // normal outcome here, not an error the caller should have to catch.
      await tx.delete(projects).where(eq(projects.id, project.id))
      return null
    }
    return { projectId: project.id }
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Public handle for /status/[slug]. A short random suffix keeps two people
 * scanning the same domain from colliding without a retry loop, and the UUID
 * never appears in a shareable URL.
 */
function slugFor(url: string): string {
  const host = hostOf(url).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  return `${host || 'site'}-${randomUUID().slice(0, 8)}`
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export interface ProjectSummary {
  project: Project
  latest: Scan | null
  previous: Scan | null
  /**
   * Difference in overall score, or null when the two scans are not comparable
   * — a different engine version or scan depth means the ruler changed, not the
   * site. Showing a number there would report our own deploy as the customer's
   * regression, which is how a monitoring product teaches people to ignore it.
   */
  delta: number | null
}

export async function listProjectSummaries(viewer: Viewer): Promise<ProjectSummary[]> {
  if (viewer.kind !== 'user') return []

  const owned = await db.query.projects.findMany({
    where: eq(projects.ownerId, viewer.userId),
    orderBy: desc(projects.createdAt),
    with: {
      // Two is all the dashboard needs: the current reading and the one to
      // compare it against.
      scans: { orderBy: desc(scans.createdAt), limit: 2 },
    },
  })

  return owned.map(({ scans: recent, ...project }) => {
    const [latest = null, previous = null] = recent
    return { project, latest, previous, delta: comparableDelta(latest, previous) }
  })
}

function comparableDelta(latest: Scan | null, previous: Scan | null): number | null {
  if (!latest?.scores || !previous?.scores) return null
  if (latest.status !== 'done' || previous.status !== 'done') return null
  if (latest.engineVersion !== previous.engineVersion) return null
  if (latest.profile !== previous.profile) return null
  // A pillar that could not be fully measured makes the total unreliable in a
  // way a single number cannot express, so no number is offered.
  if (latest.scores.degraded.length > 0 || previous.scores.degraded.length > 0) return null
  return latest.scores.overall - previous.scores.overall
}

/**
 * PUBLIC QUERY — no Viewer, by design.
 *
 * The status page at /status/[slug] is meant to be readable by anyone: it is
 * what a team links to during an incident. The slug is the capability, which is
 * why the schema generates one instead of putting a UUID in a shareable URL.
 *
 * Returns only the fields a public page may show. Selecting the row and
 * trimming it at the caller would work until somebody forgot to trim.
 *
 * NOTE: This returns the bare project row. The full public status payload
 * (per-monitor components, overall status, uptime %, incidents, maintenance)
 * lives in `getPublicStatus` in queries/monitors.ts — call that, not this,
 * when rendering a status page.
 */
export async function getPublicProjectBySlug(slug: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, slug),
    columns: { id: true, name: true, url: true, slug: true },
  })
  return project ?? null
}

/**
 * The host this project has proved it controls, or null.
 *
 * Returns a HOST rather than a yes/no about a submitted URL, and that shape is
 * the point. An earlier version compared the project's host against the URL
 * being scanned and answered true/false here — which was checked before the
 * page was fetched, and therefore before redirects. Verify evil.test, have it
 * answer `302 Location: https://victim.test/`, and the scan would pass the
 * check on evil.test and then build its entire context — HTML, scripts, the
 * Supabase keys the active checks probe — out of victim.test's document.
 *
 * So this layer answers only what it can know: which host was verified. The
 * comparison happens in buildContext against `finalUrl`, where the host we
 * actually landed on is known.
 *
 * Deliberately takes no Viewer, alongside the schedulers. It authorises
 * nothing, returns no data beyond a hostname the caller's own project already
 * stores, and answers only about a project id the caller already holds.
 */
export async function verifiedHostForProject(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null // anonymous and unclaimed scans are never active

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { url: true, verifiedDomain: true },
  })
  if (!project?.verifiedDomain) return null

  try {
    return new URL(project.url).hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null // an unparseable project URL proves nothing
  }
}


/* -------------------------------------------------------------------------- */
/* Domain ownership                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The secret an owner publishes in DNS to prove they control the domain.
 *
 * 32 bytes of randomness, prefixed so the record is self-describing when
 * somebody finds it in a zone file two years from now and wonders what it is.
 * It must be unguessable: predicting it is how a stranger claims a domain, and
 * what that unlocks is permission to probe that domain's Supabase and Firebase.
 */
export function newVerificationToken(): string {
  return `scanlyfix-verify-${randomBytes(32).toString('hex')}`
}

export interface VerificationState {
  projectId: string
  /** The name the proof is checked against — www-stripped, matching the engine. */
  host: string
  token: string | null
  verified: boolean
  verifiedAt: Date | null
}

/**
 * The host a project's ownership is proved for.
 *
 * `www.` is stripped, because that is what verifiedHostForProject returns and
 * what mayTestActively compares. Verifying `www.example.com` while the engine
 * asks about `example.com` would produce a project that is verified and still
 * refused, with nothing on screen to explain why.
 */
export function verificationHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

export async function verificationState(
  projectId: string,
  viewer: Viewer,
): Promise<VerificationState | null> {
  const project = await getProject(projectId, viewer)
  if (!project) return null

  const host = verificationHost(project.url)
  if (!host) return null

  return {
    projectId: project.id,
    host,
    token: project.verificationToken,
    verified: project.verifiedDomain,
    verifiedAt: project.verifiedAt,
  }
}

/**
 * Give this project a token if it does not have one, and return it either way.
 *
 * Idempotent on purpose. Re-issuing on every visit would invalidate a record
 * the owner had already published and was waiting on, which is the single most
 * frustrating way for a verification flow to fail.
 */
export async function ensureVerificationToken(
  projectId: string,
  viewer: Viewer,
): Promise<string | null> {
  const project = await getProject(projectId, viewer)
  if (!project) return null
  if (project.verificationToken) return project.verificationToken

  const token = newVerificationToken()
  await db.update(projects).set({ verificationToken: token }).where(eq(projects.id, projectId))
  return token
}

/**
 * Record that ownership was proved. Called only after a DNS lookup succeeded —
 * this function does no checking of its own and must never be reachable from
 * anything that has not done it.
 */
export async function markDomainVerified(projectId: string, viewer: Viewer): Promise<boolean> {
  if (!(await getProject(projectId, viewer))) return false

  await db
    .update(projects)
    .set({ verifiedDomain: true, verifiedAt: new Date() })
    .where(eq(projects.id, projectId))
  return true
}

/**
 * Withdraw the proof.
 *
 * The token is kept rather than cleared: the owner may be turning active
 * probing off temporarily, and making them re-publish a new record to turn it
 * back on is a punishment for being careful.
 */
export async function revokeDomainVerification(projectId: string, viewer: Viewer): Promise<boolean> {
  if (!(await getProject(projectId, viewer))) return false

  await db
    .update(projects)
    .set({ verifiedDomain: false, verifiedAt: null })
    .where(eq(projects.id, projectId))
  return true
}
