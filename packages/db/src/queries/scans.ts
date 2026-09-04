/**
 * Every read and write of a scan. Nothing else in the codebase touches the
 * `scans` or `findings` tables.
 *
 * Two rules this module exists to enforce, both of which are easy to get wrong
 * once and never notice:
 *
 *  1. A scan is written atomically. `completeScan` puts the findings and the
 *     scan's own row in one transaction, so there is no window where a scan
 *     reads 'done' while half its findings are missing — a state the report
 *     page would render as "your site is fine".
 *
 *  2. Nothing is readable without saying who is asking. There is deliberately
 *     no unfiltered `getScan(id)` export; see queries/viewer.ts for why that
 *     matters more here than in a project using RLS.
 */

import { and, count, desc, eq, gte, isNull, min, or } from 'drizzle-orm'
import type { Finding, ScanScores } from '@scanlyfix/checks'
import { db } from '../client.ts'
import {
  findings,
  projects,
  scans,
  type FindingRow,
  type Scan,
  type ScanContextMeta,
  type ScanProfile,
} from '../schema.ts'
import type { Viewer } from './viewer.ts'

export interface ScanWithFindings extends Scan {
  findings: FindingRow[]
}

/**
 * What a caller supplies to open a scan — deliberately narrower than the
 * table's insert type, which would also accept `status`, `scores` and the
 * timestamps this module owns.
 */
export interface CreateScanInput {
  /** Already normalized by lib/url.ts — this layer does not parse URLs. */
  url: string
  profile: ScanProfile
  /** Both required by the column, and both known before the scan starts. */
  engineVersion: string
  checksRun: number
  projectId?: string | null
  requestedBy?: string | null
  /** Hashed upstream. A raw address must never reach this table. */
  anonIpHash?: string | null
}

export interface ScanResult {
  scores: ScanScores
  findings: readonly Finding[]
  contextMeta: ScanContextMeta
  checkErrors: readonly { checkId: string; message: string }[]
  durationMs: number
}

/**
 * Postgres caps a statement at 65535 bound parameters. Findings carry ten
 * columns each, so the real ceiling is ~6500 rows — this leaves an order of
 * magnitude of headroom for the Phase 6 crawl, which multiplies finding counts
 * by the number of pages.
 */
const INSERT_CHUNK = 500

/**
 * Reserves a scan row. The work has NOT started yet, so the row says 'queued'
 * and `startedAt` stays null until markScanRunning writes it.
 *
 * This wrote 'running' with a timestamp while every scan ran inline, when
 * reserving and starting were the same instant. On the queue they are not, and
 * the difference is load-bearing twice over:
 *
 *   - a job Inngest never delivered would sit in 'running' forever, looking
 *     exactly like one being worked on. The status index exists to sweep up
 *     stuck scans, and it cannot see a stuck scan it cannot distinguish.
 *   - `startedAt` minus `createdAt` is queue latency. Stamping both at
 *     reservation makes that zero by construction, which is the one number
 *     that tells a slow scan apart from a backed-up queue.
 *
 * The inline path loses nothing: runScanJob calls executeScan immediately, and
 * executeScan's first act is markScanRunning.
 */
export async function createScan(input: CreateScanInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(scans)
    .values({
      url: input.url,
      // Derived rather than accepted, so the column the rate limiter trusts
      // can never disagree with the URL stored next to it.
      targetHost: new URL(input.url).hostname,
      profile: input.profile,
      engineVersion: input.engineVersion,
      checksRun: input.checksRun,
      projectId: input.projectId ?? null,
      requestedBy: input.requestedBy ?? null,
      anonIpHash: input.anonIpHash ?? null,
      status: 'queued',
    })
    .returning({ id: scans.id })

  if (!row) throw new Error('createScan: insert returned no row')
  return row
}

/**
 * Writes the findings and closes the scan in one transaction.
 *
 * Idempotent on `scanId`: existing findings are cleared first, so a retried
 * job — Inngest retries by design in Phase 5 — produces the same rows rather
 * than a second copy of every finding.
 */
/**
 * A worker has picked this job up.
 *
 * `startedAt` exists precisely for this and was never written while every scan
 * ran inline — createdAt and startedAt were the same instant, so the column was
 * a lie by omission. On the queue they diverge by however long the job waited,
 * which is the only way to tell a slow scan from a backed-up queue.
 *
 * Deliberately does not guard on the current status. Inngest retries, and a
 * retry re-entering 'running' from 'running' is correct; the write is
 * idempotent and the timestamp moving to the latest attempt is what you want
 * when reading how long the work actually took.
 */
export async function markScanRunning(scanId: string): Promise<void> {
  await db
    .update(scans)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(scans.id, scanId))
}

export async function completeScan(scanId: string, result: ScanResult): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(findings).where(eq(findings.scanId, scanId))

    const rows = result.findings.map((f) => ({
      scanId,
      checkId: f.checkId,
      category: f.category,
      severity: f.severity,
      title: f.title,
      description: f.description,
      evidence: f.evidence ?? null,
      remediation: f.remediation,
      fixPrompt: f.fixPrompt,
    }))

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(findings).values(rows.slice(i, i + INSERT_CHUNK))
    }

    await tx
      .update(scans)
      .set({
        status: 'done',
        finishedAt: new Date(),
        durationMs: result.durationMs,
        scores: result.scores,
        contextMeta: result.contextMeta,
        checkErrors: [...result.checkErrors],
      })
      .where(eq(scans.id, scanId))
  })

  // Phase 7.1 onboarding: first scan completion enables the project's
  // rescan monitor. Done OUTSIDE the scan transaction so a monitor
  // failure does not roll back the scan, and the helper's idempotency
  // (where clause requires `enabled = false`) makes retries safe.
  //
  // We read the scan's projectId first — anonymous scans never have a
  // project, and the auto-enable is meaningless for them. The helper
  // returns false when no rescan row exists, which is also the case for
  // projects created before Phase 7.1 — both are no-ops.
  await maybeEnableRescanAfterScan(scanId)
}

/**
 * Look up the scan's projectId and, if there is one, attempt the
 * auto-enable. Best-effort: failures here are logged and swallowed
 * rather than thrown, because the scan has already succeeded and a
 * missing rescan-enable is recoverable (a manual toggle fixes it).
 */
async function maybeEnableRescanAfterScan(scanId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ projectId: scans.projectId })
      .from(scans)
      .where(eq(scans.id, scanId))
      .limit(1)
    if (!row?.projectId) return

    const { enableRescanMonitorIfPresent } = await import('./onboarding-defaults.ts')
    await enableRescanMonitorIfPresent(row.projectId)
  } catch (error) {
    // Onboarding auto-enable is best-effort; the scan result is the
    // durable artefact and a missing rescan-enable is recoverable
    // via the manual toggle on /projects/[id]/monitors.
    console.error('[completeScan] rescan auto-enable failed:', error)
  }
}

/**
 * A scan that could not be produced: an SSRF-blocked target, a host that never
 * answered, a TLS handshake that failed. All of those are results the user is
 * owed an explanation for, not server errors — so they land here and the scan
 * page renders them, rather than the request throwing a 500.
 */
export async function failScan(scanId: string, error: string, durationMs?: number): Promise<void> {
  await db
    .update(scans)
    // durationMs is recorded for failures too: a scan that died after 10s hit a
    // timeout, one that died after 40ms hit a DNS error, and telling those two
    // apart from a support question is otherwise guesswork.
    .set({ status: 'failed', finishedAt: new Date(), error, durationMs: durationMs ?? null })
    .where(eq(scans.id, scanId))
}

/**
 * The only way to read a scan.
 *
 * Two access rules, and the split matters:
 *
 *  - An anonymous scan (no project, no requester) is readable by anyone
 *    holding the id. That is the product: paste a URL, get a link, share it.
 *    The id is a random UUID and is the capability.
 *
 *  - A scan attached to a project or a user belongs to that account, and only
 *    its owner may read it. Treating these the same as anonymous scans would
 *    make every customer's history public to anyone who guessed an id;
 *    treating anonymous scans as private would break the shareable report.
 */
export async function getScanForViewer(scanId: string, viewer: Viewer): Promise<ScanWithFindings | null> {
  const scan = await db.query.scans.findFirst({
    where: eq(scans.id, scanId),
    with: {
      /*
       * ORDERED, and this is load-bearing rather than cosmetic.
       *
       * The engine sorts worst-first and everything downstream assumes it
       * still is: findings-list.tsx renders in array order, and redactFindings
       * opens the first N — so on a plan that shows "the three worst", an
       * unordered read hands out three arbitrary ones instead. The free report
       * gets less useful and the paid one leaks, from the same missing clause.
       *
       * `with: { findings: true }` does not preserve insertion order. Drizzle
       * builds the relation as a lateral join, and a join has no obligation to
       * return rows the way they went in — this read came back low-severity
       * first from a table whose heap order was worst-first.
       *
       * `asc(severity)` is correct because a Postgres enum sorts by DECLARED
       * order, and severityEnum is declared critical → info. The checkId
       * tiebreak matches registry.ts exactly, so two findings of equal
       * severity land in the same place here as they did in the engine.
       */
      findings: { orderBy: (f, { asc }) => [asc(f.severity), asc(f.checkId)] },
      project: { columns: { ownerId: true } },
    },
  })
  if (!scan) return null

  const { project, ...row } = scan
  const isAnonymous = row.projectId === null && row.requestedBy === null
  if (isAnonymous) return row

  if (viewer.kind !== 'user') return null
  const owns = row.requestedBy === viewer.userId || project?.ownerId === viewer.userId
  return owns ? row : null
}

/* -------------------------------------------------------------------------- */
/* Rate limiting and deduplication                                            */
/* -------------------------------------------------------------------------- */

/**
 * These count rows in `scans`, which means they count scans that were actually
 * STARTED — the expensive thing — rather than HTTP requests. A flood of
 * requests that never becomes a scan costs a count query and nothing else, and
 * belongs to the CDN rather than to this table.
 *
 * Postgres rather than Redis on purpose: a scan is seconds of network work, so
 * request volume here is inherently low, and the columns were already being
 * written. If that stops being true, replace the bodies — the callers only see
 * the counts.
 */

/**
 * How many scans matched, and when the earliest of them ran.
 *
 * The timestamp comes back from the same query because the caller needs it
 * only to say when the window reopens — and a limit message without a time is
 * a support ticket.
 */
export interface WindowUsage {
  count: number
  oldest: Date | null
}

/** How many scans this visitor has started since `since`. */
export async function countScansByIpSince(anonIpHash: string, since: Date): Promise<WindowUsage> {
  const [row] = await db
    .select({ n: count(), oldest: min(scans.createdAt) })
    .from(scans)
    .where(and(eq(scans.anonIpHash, anonIpHash), gte(scans.createdAt, since)))
  return { count: row?.n ?? 0, oldest: row?.oldest ?? null }
}

/**
 * How many scans ANYONE has started against this host since `since`.
 *
 * The limit other people are protected by. Without it, ten visitors with ten
 * addresses can point this service at one small site, and the abuse report
 * arrives at our host rather than theirs.
 */
export async function countScansByHostSince(targetHost: string, since: Date): Promise<WindowUsage> {
  const [row] = await db
    .select({ n: count(), oldest: min(scans.createdAt) })
    .from(scans)
    .where(and(eq(scans.targetHost, targetHost), gte(scans.createdAt, since)))
  return { count: row?.n ?? 0, oldest: row?.oldest ?? null }
}

/**
 * How many scans this ACCOUNT has started since `since`.
 *
 * Distinct from countScansByIpSince, and the two are not interchangeable. That
 * one is abuse protection measured per visitor per hour; this one is the plan
 * allowance measured per account per month, and it counts only scans a
 * signed-in person actually caused — `requestedBy` is null on an anonymous
 * scan, which has no allowance to spend.
 *
 * A cache hit is deliberately not counted anywhere, because no scan happened:
 * the dedup in the scan route answers from a recent result without touching
 * the target, and charging for that would be charging for nothing.
 */
export async function countScansForUserSince(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(scans)
    .where(and(eq(scans.requestedBy, userId), gte(scans.createdAt, since)))
  return row?.n ?? 0
}

/**
 * The most recent finished scan of this exact URL and depth, for reuse instead
 * of re-fetching someone else's server.
 *
 * Restricted to scans that are themselves anonymous. A scan belonging to a
 * project is private, and handing its id back as a cache hit would both leak
 * that the project exists and send the visitor to a report they cannot read.
 *
 * Only 'done' scans qualify: a failed one should be retryable straight away,
 * and a running one has nothing to show yet.
 */
export async function findRecentAnonymousScan(
  url: string,
  profile: ScanProfile,
  since: Date,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        eq(scans.url, url),
        eq(scans.profile, profile),
        eq(scans.status, 'done'),
        isNull(scans.projectId),
        isNull(scans.requestedBy),
        gte(scans.createdAt, since),
      ),
    )
    .orderBy(desc(scans.createdAt))
    .limit(1)
  return row ?? null
}

/**
 * A person's own ad-hoc scans — the ones they ran from the home page without
 * saving them into a project.
 *
 * These were invisible: attributed to the account (so they count against the
 * quota) but shown nowhere, so a signed-in scan felt like it vanished. This is
 * the list the dashboard renders under the projects. Scoped to scans with no
 * project, because a project's scans already have their own history view and
 * showing them twice would double every entry.
 */
export async function listRecentScansForUser(viewer: Viewer, limit = 8) {
  if (viewer.kind !== 'user') return []
  return db.query.scans.findMany({
    where: and(eq(scans.requestedBy, viewer.userId), isNull(scans.projectId)),
    orderBy: desc(scans.createdAt),
    limit,
  })
}

/**
 * The signed-in equivalent of the dedup above.
 *
 * Scanning now requires an account, so a repeat of the same URL is a repeat by
 * a KNOWN person, and their own recent result is the one to hand back — not
 * some stranger's, and not nothing. Without this, every re-scan of a URL was a
 * fresh fetch that spent the account's allowance and a rate-limit slot on work
 * already done seconds ago, because the anonymous dedup requires
 * `requestedBy IS NULL` and a signed-in scan never matches it.
 *
 * Matched to this user's own ad-hoc scans (no project), so it cannot return a
 * scan that belongs to a project the user reaches a different way.
 */
export async function findRecentScanForUser(
  url: string,
  profile: ScanProfile,
  userId: string,
  since: Date,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        eq(scans.url, url),
        eq(scans.profile, profile),
        eq(scans.status, 'done'),
        isNull(scans.projectId),
        eq(scans.requestedBy, userId),
        gte(scans.createdAt, since),
      ),
    )
    .orderBy(desc(scans.createdAt))
    .limit(1)
  return row ?? null
}

/**
 * The URL-paste flow's dedup, broadened to cover scans the user filed under
 * one of their own projects.
 *
 * findRecentScanForUser above only matches `projectId IS NULL`, because that
 * was the only scan a paste created. The scan path now bootstraps a project +
 * four monitors alongside the scan (see app/api/scan/route.ts), so a re-paste
 * lands on `scans` rows that DO have a projectId — and the dedup must include
 * them, otherwise the second paste creates a second scan and burns a quota
 * slot on a URL we just measured seconds ago.
 *
 * Auth is enforced through the project: a LEFT JOIN to projects filters by
 * ownerId, so a scan filed under somebody else's project never matches — and
 * cannot leak its id to a stranger guessing URLs.
 *
 * Returns the scan id AND the project id, because the dedup-hit path now has
 * to navigate to the project page, not the scan page, to show the user the
 * domain they're already watching.
 */
export async function findRecentScanForUserAcrossProjects(
  url: string,
  profile: ScanProfile,
  userId: string,
  since: Date,
): Promise<{ id: string; projectId: string | null } | null> {
  // Auth lives entirely in the WHERE clause so a single query does the
  // dedup AND the ownership check. The two halves:
  //
  //   isNull(scans.projectId)                       — ad-hoc scan, no project
  //                                                  to own, so the user is
  //                                                  trusted by `requestedBy`.
  //   eq(projects.ownerId, userId)                  — project-linked scan, only
  //                                                  matched when THIS user
  //                                                  owns the project.
  //
  // A scan filed under somebody else's project fails BOTH halves and is
  // filtered out without a second round trip.
  const [row] = await db
    .select({ id: scans.id, projectId: scans.projectId })
    .from(scans)
    .leftJoin(projects, eq(scans.projectId, projects.id))
    .where(
      and(
        eq(scans.url, url),
        eq(scans.profile, profile),
        eq(scans.status, 'done'),
        eq(scans.requestedBy, userId),
        gte(scans.createdAt, since),
        or(isNull(scans.projectId), eq(projects.ownerId, userId)),
      ),
    )
    .orderBy(desc(scans.createdAt))
    .limit(1)

  return row ?? null
}
