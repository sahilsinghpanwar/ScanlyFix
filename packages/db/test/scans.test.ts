/**
 * The scan query layer, against a real Postgres.
 *
 * These need a live database, so they run only when asked:
 *
 *   SCANLYFIX_DB=1 pnpm --filter @scanlyfix/db test
 *
 * Most of what follows is about getScanForViewer, because this module is the
 * ONLY thing standing between one account's scans and another's. Drizzle
 * connects as the database owner, so Postgres row-level security is bypassed
 * — there is no second layer to catch a mistake here.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import type { Finding, ScanScores } from '@scanlyfix/checks'
import { db } from '../src/client.ts'
import { organizations, projects, scans, users, type ScanContextMeta } from '../src/schema.ts'
import {
  completeScan,
  countScansByHostSince,
  countScansByIpSince,
  createScan,
  failScan,
  findRecentAnonymousScan,
  findRecentScanForUser,
  findRecentScanForUserAcrossProjects,
  getScanForViewer,
  listRecentScansForUser,
  markScanRunning,
} from '../src/queries/scans.ts'
import { ANONYMOUS, type Viewer } from '../src/queries/viewer.ts'

const live = process.env.SCANLYFIX_DB === '1'

const SCORES: ScanScores = {
  security: 70, seo: 100, aeo: 100, performance: 100,
  accessibility: 100, compliance: 100, overall: 85, degraded: [],
}

const META: ScanContextMeta = {
  finalUrl: 'https://example.test/',
  redirectChain: [],
  status: 200,
  framework: null,
  tlsExpiry: null,
}

const finding = (checkId: string): Finding => ({
  checkId,
  category: 'security',
  severity: 'high',
  title: `synthetic ${checkId}`,
  description: 'synthetic',
  evidence: { header: 'synthetic' },
  remediation: 'synthetic',
  fixPrompt: 'synthetic',
})

const open = (overrides: Partial<Parameters<typeof createScan>[0]> = {}) =>
  createScan({
    url: 'https://example.test/',
    profile: 'fast',
    engineVersion: '0.0.0-test',
    checksRun: 29,
    ...overrides,
  })

describe.skipIf(!live)('scan queries (SCANLYFIX_DB=1)', () => {
  const createdScans: string[] = []
  let ownerId: string
  let strangerId: string
  let projectId: string

  const track = async (p: Promise<{ id: string }>) => {
    const row = await p
    createdScans.push(row.id)
    return row.id
  }

  beforeAll(async () => {
    ownerId = randomUUID()
    strangerId = randomUUID()
    await db.insert(users).values([
      { id: ownerId, email: `owner-${ownerId}@example.test` },
      { id: strangerId, email: `stranger-${strangerId}@example.test` },
    ])
    const [org] = await db
      .insert(organizations).values({ name: 'test org', ownerId }).returning({ id: organizations.id })
    const [project] = await db
      .insert(projects)
      .values({ ownerId, orgId: org!.id, name: 'test', url: 'https://example.test/', slug: `t-${randomUUID()}` })
      .returning({ id: projects.id })
    projectId = project!.id
  })

  afterAll(async () => {
    if (createdScans.length) await db.delete(scans).where(inArray(scans.id, createdScans))
    await db.delete(users).where(inArray(users.id, [ownerId, strangerId]))
  })

  it('reserves a scan as queued, unstarted, with its measurement identity recorded', async () => {
    const id = await track(open())
    const row = await db.query.scans.findFirst({ where: eq(scans.id, id) })
    // Reserved, not started. A row that claimed 'running' at reservation made
    // a job the queue never delivered indistinguishable from one in progress,
    // and made startedAt - createdAt — the queue latency — zero by construction.
    expect(row?.status).toBe('queued')
    expect(row?.startedAt).toBeNull()
    expect(row?.engineVersion).toBe('0.0.0-test')
    expect(row?.checksRun).toBe(29)
    expect(row?.profile).toBe('fast')
    expect(row?.checkErrors).toEqual([])
  })

  it('moves a reserved scan to running and stamps when the work began', async () => {
    // The only transition out of 'queued'. Before it existed the two states
    // were written at once, so queue latency — startedAt minus createdAt — was
    // always zero and a scan nobody ever picked up looked like one in flight.
    const before = Date.now()
    const id = await track(open())
    await markScanRunning(id)

    const row = await db.query.scans.findFirst({ where: eq(scans.id, id) })
    expect(row?.status).toBe('running')
    // Bounded against the NODE clock, not against createdAt. That column is
    // Postgres's defaultNow() and startedAt is new Date() here, so comparing
    // them measures clock skew between two machines rather than anything the
    // code decides.
    expect(row!.startedAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(row!.startedAt!.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('is idempotent, because Inngest retries', async () => {
    const id = await track(open())
    await markScanRunning(id)
    const first = await db.query.scans.findFirst({ where: eq(scans.id, id) })

    await markScanRunning(id)
    const second = await db.query.scans.findFirst({ where: eq(scans.id, id) })

    // Re-entering 'running' from 'running' is correct, and the timestamp
    // moving to the latest attempt is what you want when reading how long the
    // work actually took.
    expect(second?.status).toBe('running')
    expect(second!.startedAt!.getTime()).toBeGreaterThanOrEqual(first!.startedAt!.getTime())
  })

  it('stores findings and closes the scan together', async () => {
    const id = await track(open())
    await completeScan(id, {
      scores: SCORES,
      findings: [finding('security.headers.csp'), finding('security.headers.hsts')],
      contextMeta: META,
      checkErrors: [{ checkId: 'seo.sitemap', message: 'timed out' }],
      durationMs: 1234,
    })

    const scan = await getScanForViewer(id, ANONYMOUS)
    expect(scan?.status).toBe('done')
    expect(scan?.durationMs).toBe(1234)
    expect(scan?.scores).toEqual(SCORES)
    expect(scan?.contextMeta).toEqual(META)
    expect(scan?.checkErrors).toEqual([{ checkId: 'seo.sitemap', message: 'timed out' }])
    expect(scan?.findings).toHaveLength(2)
    expect(scan?.findings[0]?.evidence).toEqual({ header: 'synthetic' })
  })

  it('is idempotent, so a retried job does not duplicate every finding', async () => {
    // Inngest retries by design in Phase 5; without the delete-first this
    // silently doubles a scan's findings and halves its apparent score.
    const id = await track(open())
    const result = {
      scores: SCORES, findings: [finding('security.headers.csp')],
      contextMeta: META, checkErrors: [], durationMs: 10,
    }
    await completeScan(id, result)
    await completeScan(id, result)
    expect((await getScanForViewer(id, ANONYMOUS))?.findings).toHaveLength(1)
  })

  it('records a scan with no findings without erroring on an empty insert', async () => {
    const id = await track(open())
    await completeScan(id, { scores: SCORES, findings: [], contextMeta: META, checkErrors: [], durationMs: 5 })
    expect((await getScanForViewer(id, ANONYMOUS))?.findings).toEqual([])
  })

  it('keeps a failed scan readable, with its reason', async () => {
    const id = await track(open())
    await failScan(id, 'refused to scan a private address')
    const scan = await getScanForViewer(id, ANONYMOUS)
    expect(scan?.status).toBe('failed')
    expect(scan?.error).toContain('private address')
  })

  it('returns null for a scan id that does not exist', async () => {
    expect(await getScanForViewer(randomUUID(), ANONYMOUS)).toBeNull()
  })

  it('derives target_host from the url so per-host limiting cannot be bypassed by path', async () => {
    // /1, /2, /3 are three URLs and one server. Limiting on the URL is no limit.
    const id = await track(open({ url: 'https://example.test/deep/page?q=1' }))
    const row = await db.query.scans.findFirst({ where: eq(scans.id, id) })
    expect(row?.targetHost).toBe('example.test')
  })

  it('records how long a failed scan took, so a timeout is distinguishable from a DNS error', async () => {
    const id = await track(open())
    await failScan(id, 'Could not resolve hostname: nope.invalid', 42)
    const row = await db.query.scans.findFirst({ where: eq(scans.id, id) })
    expect(row?.durationMs).toBe(42)
  })

  describe('rate-limit counters', () => {
    const hourAgo = () => new Date(Date.now() - 3_600_000)

    it('counts a visitor\'s scans and reports the oldest, for the retry-after message', async () => {
      const ip = `hash-${randomUUID()}`
      await track(open({ anonIpHash: ip }))
      await track(open({ anonIpHash: ip }))
      const usage = await countScansByIpSince(ip, hourAgo())
      expect(usage.count).toBe(2)
      expect(usage.oldest).toBeInstanceOf(Date)
    })

    it('counts scans of a host across ALL visitors — the limit that protects the site', async () => {
      const host = `h-${randomUUID()}.test`
      await track(open({ url: `https://${host}/a`, anonIpHash: `hash-${randomUUID()}` }))
      await track(open({ url: `https://${host}/b`, anonIpHash: `hash-${randomUUID()}` }))
      // Two different visitors, two different paths, one host: both count.
      expect((await countScansByHostSince(host, hourAgo())).count).toBe(2)
    })

    it('ignores scans older than the window', async () => {
      const ip = `hash-${randomUUID()}`
      await track(open({ anonIpHash: ip }))
      const future = new Date(Date.now() + 60_000)
      expect((await countScansByIpSince(ip, future)).count).toBe(0)
    })
  })

  describe('deduplication', () => {
    const recently = () => new Date(Date.now() - 600_000)
    const done = { scores: SCORES, findings: [], contextMeta: META, checkErrors: [], durationMs: 1 }

    it('reuses a recent finished anonymous scan of the same url and profile', async () => {
      const url = `https://dedup-${randomUUID()}.test/`
      const id = await track(open({ url }))
      await completeScan(id, done)
      expect((await findRecentAnonymousScan(url, 'fast', recently()))?.id).toBe(id)
    })

    it('never hands back a project\'s scan, which the visitor could not read anyway', async () => {
      // The important one. A cache hit on a private scan would both leak that
      // the project exists and send the visitor to a report they are refused.
      const url = `https://private-${randomUUID()}.test/`
      const id = await track(open({ url, projectId, requestedBy: ownerId }))
      await completeScan(id, done)
      expect(await findRecentAnonymousScan(url, 'fast', recently())).toBeNull()
    })

    it('skips a scan that failed, so a retry is immediate', async () => {
      const url = `https://failed-${randomUUID()}.test/`
      const id = await track(open({ url }))
      await failScan(id, 'host unreachable')
      expect(await findRecentAnonymousScan(url, 'fast', recently())).toBeNull()
    })

    it('skips a scan that is still running', async () => {
      const url = `https://running-${randomUUID()}.test/`
      await track(open({ url }))
      expect(await findRecentAnonymousScan(url, 'fast', recently())).toBeNull()
    })

    it('does not cross profiles — a deep scan is not an answer to a fast question', async () => {
      const url = `https://profile-${randomUUID()}.test/`
      const id = await track(open({ url, profile: 'deep' }))
      await completeScan(id, done)
      expect(await findRecentAnonymousScan(url, 'fast', recently())).toBeNull()
      expect((await findRecentAnonymousScan(url, 'deep', recently()))?.id).toBe(id)
    })

    it('ignores a scan older than the window', async () => {
      const url = `https://stale-${randomUUID()}.test/`
      const id = await track(open({ url }))
      await completeScan(id, done)
      expect(await findRecentAnonymousScan(url, 'fast', new Date(Date.now() + 60_000))).toBeNull()
    })
  })

  describe('per-account deduplication (signed-in scans)', () => {
    const recently = () => new Date(Date.now() - 600_000)
    const done = { scores: SCORES, findings: [], contextMeta: META, checkErrors: [], durationMs: 1 }

    it('reuses this account\'s own recent finished scan of the same url and profile', async () => {
      const url = `https://u-dedup-${randomUUID()}.test/`
      const id = await track(open({ url, requestedBy: ownerId }))
      await completeScan(id, done)
      expect((await findRecentScanForUser(url, 'fast', ownerId, recently()))?.id).toBe(id)
    })

    it('does not hand one account another account\'s scan', async () => {
      const url = `https://u-cross-${randomUUID()}.test/`
      const id = await track(open({ url, requestedBy: ownerId }))
      await completeScan(id, done)
      // Same URL, different account: no cache hit, so it scans afresh under its
      // own name rather than reusing — and being billed for — someone else's.
      expect(await findRecentScanForUser(url, 'fast', strangerId, recently())).toBeNull()
    })

    it('does not treat an anonymous scan as this account\'s', async () => {
      const url = `https://u-anon-${randomUUID()}.test/`
      const id = await track(open({ url }))
      await completeScan(id, done)
      expect(await findRecentScanForUser(url, 'fast', ownerId, recently())).toBeNull()
    })

    it('does not cross profiles', async () => {
      const url = `https://u-profile-${randomUUID()}.test/`
      const id = await track(open({ url, profile: 'deep', requestedBy: ownerId }))
      await completeScan(id, done)
      expect(await findRecentScanForUser(url, 'fast', ownerId, recently())).toBeNull()
      expect((await findRecentScanForUser(url, 'deep', ownerId, recently()))?.id).toBe(id)
    })
  })

  describe('URL-paste dedup (ad-hoc OR project-filed scans)', () => {
    const recently = () => new Date(Date.now() - 600_000)
    const done = { scores: SCORES, findings: [], contextMeta: META, checkErrors: [], durationMs: 1 }

    it('reuses this account\'s recent ad-hoc scan of the same URL', async () => {
      const url = `https://paste-adhoc-${randomUUID()}.test/`
      const id = await track(open({ url, requestedBy: ownerId }))
      await completeScan(id, done)
      const hit = await findRecentScanForUserAcrossProjects(url, 'fast', ownerId, recently())
      expect(hit?.id).toBe(id)
      expect(hit?.projectId).toBeNull()
    })

    it('reuses this account\'s recent scan filed under their own project', async () => {
      const url = `https://paste-proj-${randomUUID()}.test/`
      const id = await track(open({ url, requestedBy: ownerId, projectId }))
      await completeScan(id, done)
      const hit = await findRecentScanForUserAcrossProjects(url, 'fast', ownerId, recently())
      expect(hit?.id).toBe(id)
      expect(hit?.projectId).toBe(projectId)
    })

    it('does not hand one account a scan filed under somebody else\'s project', async () => {
      // The security boundary. The LEFT JOIN to projects filters by ownerId,
      // so this stays null even though the URL is identical and recent.
      const url = `https://paste-stranger-${randomUUID()}.test/`
      const id = await track(open({ url, requestedBy: strangerId, projectId }))
      await completeScan(id, done)
      expect(await findRecentScanForUserAcrossProjects(url, 'fast', ownerId, recently())).toBeNull()
    })

    it('does not cross profiles even when filed under a project', async () => {
      const url = `https://paste-cross-${randomUUID()}.test/`
      const id = await track(open({ url, profile: 'deep', requestedBy: ownerId, projectId }))
      await completeScan(id, done)
      expect(await findRecentScanForUserAcrossProjects(url, 'fast', ownerId, recently())).toBeNull()
      expect((await findRecentScanForUserAcrossProjects(url, 'deep', ownerId, recently()))?.id).toBe(id)
    })
  })

  describe('a person\'s ad-hoc scan history', () => {
    const viewer = (id: string): Viewer => ({ kind: 'user', userId: id })

    it('lists this account\'s own project-less scans, newest first', async () => {
      const older = await track(open({ url: `https://h1-${randomUUID()}.test/`, requestedBy: ownerId }))
      const newer = await track(open({ url: `https://h2-${randomUUID()}.test/`, requestedBy: ownerId }))

      const list = await listRecentScansForUser(viewer(ownerId), 50)
      const ids = list.map((s) => s.id)
      expect(ids).toContain(older)
      expect(ids).toContain(newer)
      // Newest first: the later-created id appears before the earlier one.
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
    })

    it('does not show another account\'s scans', async () => {
      const mine = await track(open({ url: `https://mine-${randomUUID()}.test/`, requestedBy: ownerId }))
      const theirs = await track(open({ url: `https://theirs-${randomUUID()}.test/`, requestedBy: strangerId }))

      const ids = (await listRecentScansForUser(viewer(ownerId), 50)).map((s) => s.id)
      expect(ids).toContain(mine)
      expect(ids).not.toContain(theirs)
    })

    it('excludes scans that belong to a project — those have their own history', async () => {
      const projScan = await track(open({ url: `https://proj-${randomUUID()}.test/`, requestedBy: ownerId, projectId }))
      const ids = (await listRecentScansForUser(viewer(ownerId), 50)).map((s) => s.id)
      expect(ids).not.toContain(projScan)
    })

    it('returns nothing for an anonymous viewer', async () => {
      expect(await listRecentScansForUser(ANONYMOUS)).toEqual([])
    })
  })

  describe('who may read a scan', () => {
    it('lets anyone with the id read an anonymous scan — the link IS the capability', async () => {
      const id = await track(open())
      expect(await getScanForViewer(id, ANONYMOUS)).not.toBeNull()
      const stranger: Viewer = { kind: 'user', userId: strangerId }
      expect(await getScanForViewer(id, stranger)).not.toBeNull()
    })

    it("hides a project's scan from a logged-out visitor", async () => {
      const id = await track(open({ projectId, requestedBy: ownerId }))
      expect(await getScanForViewer(id, ANONYMOUS)).toBeNull()
    })

    it("hides a project's scan from a different account", async () => {
      // The test that matters. If this ever passes, every customer's history
      // is readable by anyone who can guess a UUID.
      const id = await track(open({ projectId, requestedBy: ownerId }))
      expect(await getScanForViewer(id, { kind: 'user', userId: strangerId })).toBeNull()
    })

    it('shows a project scan to the project owner', async () => {
      const id = await track(open({ projectId, requestedBy: ownerId }))
      expect(await getScanForViewer(id, { kind: 'user', userId: ownerId })).not.toBeNull()
    })

    it('shows a requester their own project-less scan', async () => {
      const id = await track(open({ requestedBy: ownerId }))
      expect(await getScanForViewer(id, { kind: 'user', userId: ownerId })).not.toBeNull()
      expect(await getScanForViewer(id, { kind: 'user', userId: strangerId })).toBeNull()
    })
  })

  describe('the order findings come back in', () => {
    /**
     * Not cosmetic. redactFindings opens the FIRST N findings, so on a plan
     * that shows "the three worst" an unordered read hands out three arbitrary
     * ones — the free report gets less useful and the paid one leaks, from the
     * same missing clause. findings-list.tsx renders in array order for the
     * same reason.
     *
     * `with: { findings: true }` used to be the read here, and it does not
     * preserve insertion order: Drizzle builds the relation as a lateral join,
     * and this came back low-severity-first from a table written worst-first.
     */
    const ranked = (severity: Finding['severity'], checkId: string): Finding => ({
      ...finding(checkId),
      severity,
    })

    it('returns findings worst-first however they were written', async () => {
      const id = await track(open())
      await completeScan(id, {
        scores: SCORES,
        // Deliberately inserted in the WRONG order — the guarantee is about
        // what comes out, not about what a caller happened to put in.
        findings: [
          ranked('info', 'z.info'),
          ranked('low', 'm.low'),
          ranked('critical', 'a.critical'),
          ranked('medium', 'k.medium'),
          ranked('high', 'b.high'),
        ],
        contextMeta: META,
        checkErrors: [],
        durationMs: 1,
      })

      const scan = await getScanForViewer(id, ANONYMOUS)
      expect(scan!.findings.map((f) => f.severity)).toEqual([
        'critical',
        'high',
        'medium',
        'low',
        'info',
      ])
    })

    it('breaks ties on checkId, exactly as the engine does', async () => {
      const id = await track(open())
      await completeScan(id, {
        scores: SCORES,
        findings: [ranked('high', 'c.third'), ranked('high', 'a.first'), ranked('high', 'b.second')],
        contextMeta: META,
        checkErrors: [],
        durationMs: 1,
      })

      const scan = await getScanForViewer(id, ANONYMOUS)
      // registry.ts sorts `rank(a) - rank(b) || a.checkId.localeCompare(b.checkId)`.
      // Two equal-severity findings must land here where they did there.
      expect(scan!.findings.map((f) => f.checkId)).toEqual(['a.first', 'b.second', 'c.third'])
    })
  })
})
