/**
 * GitHub installation / repo query layer, against a real Postgres.
 *
 *   SCANLYFIX_DB=1 pnpm --filter @scanlyfix/db test
 *
 * The whole point of this file is authorization. Drizzle connects as the
 * database owner, so Postgres row-level security is bypassed and the WHERE
 * clauses here are the only barrier between one account's repos and another's.
 *
 * Specifically guards the regression that shipped here: listReposForViewer and
 * getRepoForViewer were written against Drizzle's relational query API and
 * filtered on `githubInstallations.userId` from inside a `githubRepos` query.
 * Drizzle does not auto-traverse the `installation` relation in a `where`
 * clause — it treats the joined column as if it lived on the queried table
 * and emits `WHERE githubRepos.user_id = $...`, which fails because the
 * column is on `github_installations`. The 500 on /dashboard was that bug.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../src/client.ts'
import {
  githubInstallations,
  githubRepos,
  users,
} from '../src/schema.ts'
import { ensureUser } from '../src/queries/users.ts'
import {
  deleteInstallationByGithubId,
  deleteReposByGithubIds,
  getInstallationByGithubId,
  getInstallationForViewer,
  getRepoForViewer,
  getRepoWithInstallationForViewer,
  listInstallationsForViewer,
  listReposForViewer,
  upsertInstallation,
  upsertRepo,
} from '../src/queries/github-installations.ts'
import { ANONYMOUS, type Viewer } from '../src/queries/viewer.ts'

const live = process.env.SCANLYFIX_DB === '1'

const viewer = (userId: string): Viewer => ({ kind: 'user', userId })

describe.skipIf(!live)('github installations and repos (SCANLYFIX_DB=1)', () => {
  /**
   * Track everything we create so afterAll can wipe it. github_installations
   * cascades to github_repos via the FK, so deleting users is enough to clean
   * the whole tree — no need to track repos or installations separately.
   */
  const createdUserIds: string[] = []
  const newIdentity = () => {
    const subject = randomUUID()
    return { subject, email: `gh-${subject}@example.test` }
  }
  const makeUser = async (): Promise<string> => {
    const identity = newIdentity()
    const id = await ensureUser(identity)
    createdUserIds.push(id)
    return id
  }
  const makeInstallation = async (
    userId: string,
    installationId: number,
    login = `acct-${installationId}`,
  ): Promise<string> => {
    const row = await upsertInstallation(viewer(userId), {
      installationId,
      accountLogin: login,
      accountType: 'User',
    })
    if (!row) throw new Error('upsertInstallation returned null')
    return row.id
  }
  const makeRepo = async (installationRowId: string, suffix: string) =>
    upsertRepo({
      installationId: installationRowId,
      owner: `owner-${suffix}`,
      name: `repo-${suffix}`,
      fullName: `owner-${suffix}/repo-${suffix}`,
      defaultBranch: 'main',
      private: false,
      githubId: Math.floor(Math.random() * 1e15),
    })

  afterAll(async () => {
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds))
  })

  describe('listReposForViewer', () => {
    it('returns [] for an anonymous viewer', async () => {
      await expect(listReposForViewer(ANONYMOUS)).resolves.toEqual([])
    })

    it('returns the viewer\'s repos across every installation, newest first', async () => {
      const userId = await makeUser()
      const olderInstallation = await makeInstallation(userId, randomInstallationId())
      const newerInstallation = await makeInstallation(userId, randomInstallationId())

      const olderRepo = await makeRepo(olderInstallation, 'older')
      const newerRepo = await makeRepo(newerInstallation, 'newer')

      const result = await listReposForViewer(viewer(userId))
      const ids = result.map((r) => r.id)
      expect(ids).toContain(olderRepo?.id)
      expect(ids).toContain(newerRepo?.id)
      expect(result[0]?.id).toBe(newerRepo?.id)
    })

    it('does not leak another user\'s repos', async () => {
      const ownerId = await makeUser()
      const intruderId = await makeUser()
      const ownerInstallation = await makeInstallation(ownerId, randomInstallationId())
      const ownerRepo = await makeRepo(ownerInstallation, 'private')

      const seen = await listReposForViewer(viewer(intruderId))
      const seenIds = seen.map((r) => r.id)
      expect(seenIds).not.toContain(ownerRepo?.id)
    })
  })

  describe('getRepoForViewer', () => {
    it('returns the repo for its owner', async () => {
      const userId = await makeUser()
      const installationId = await makeInstallation(userId, randomInstallationId())
      const repo = await makeRepo(installationId, 'mine')

      const found = await getRepoForViewer(repo!.id, viewer(userId))
      expect(found?.id).toBe(repo?.id)
    })

    it('returns null when the viewer does not own the repo', async () => {
      const ownerId = await makeUser()
      const intruderId = await makeUser()
      const installationId = await makeInstallation(ownerId, randomInstallationId())
      const repo = await makeRepo(installationId, 'foreign')

      await expect(getRepoForViewer(repo!.id, viewer(intruderId))).resolves.toBeNull()
    })

    it('returns null for an anonymous viewer', async () => {
      const userId = await makeUser()
      const installationId = await makeInstallation(userId, randomInstallationId())
      const repo = await makeRepo(installationId, 'anon')

      await expect(getRepoForViewer(repo!.id, ANONYMOUS)).resolves.toBeNull()
    })
  })

  describe('getRepoWithInstallationForViewer', () => {
    it('returns the numeric installation id the repo belongs to', async () => {
      const userId = await makeUser()
      const numericInstallationId = randomInstallationId()
      const installationRowId = await makeInstallation(userId, numericInstallationId)
      const repo = await makeRepo(installationRowId, 'paired')

      const result = await getRepoWithInstallationForViewer(repo!.id, viewer(userId))
      expect(result?.repo.id).toBe(repo?.id)
      expect(result?.installationId).toBe(numericInstallationId)
    })
  })

  describe('upsertInstallation', () => {
    it('reuses the existing row when GitHub re-installs the same grant', async () => {
      const userId = await makeUser()
      const numericInstallationId = randomInstallationId()
      const first = await upsertInstallation(viewer(userId), {
        installationId: numericInstallationId,
        accountLogin: 'first',
        accountType: 'User',
      })
      const second = await upsertInstallation(viewer(userId), {
        installationId: numericInstallationId,
        accountLogin: 'second',
        accountType: 'User',
      })
      expect(first?.id).toBe(second?.id)
    })

    it('moves the row to whoever completes the install when a different account signs in', async () => {
      const firstUserId = await makeUser()
      const secondUserId = await makeUser()
      const numericInstallationId = randomInstallationId()

      // Installed under account A — the row is keyed to A's app user id.
      const first = await upsertInstallation(viewer(firstUserId), {
        installationId: numericInstallationId,
        accountLogin: 'account-a',
        accountType: 'User',
      })

      // The SAME GitHub grant is then completed while signed in as B. GitHub
      // reuses the same installation id, so this must reassign the row to B —
      // otherwise B's feed is empty forever and re-installing never helps.
      const second = await upsertInstallation(viewer(secondUserId), {
        installationId: numericInstallationId,
        accountLogin: 'account-b',
        accountType: 'User',
      })

      expect(second?.id).toBe(first?.id)
      expect(second?.userId).toBe(secondUserId)

      const viaFirst = await listInstallationsForViewer(viewer(firstUserId))
      const viaSecond = await listInstallationsForViewer(viewer(secondUserId))
      expect(viaFirst.map((i) => i.id)).not.toContain(first?.id)
      expect(viaSecond.map((i) => i.id)).toContain(second?.id)
    })

    it('returns null for an anonymous viewer', async () => {
      await expect(
        upsertInstallation(ANONYMOUS, {
          installationId: randomInstallationId(),
          accountLogin: 'x',
          accountType: 'User',
        }),
      ).resolves.toBeNull()
    })
  })

  describe('listInstallationsForViewer / getInstallationForViewer', () => {
    it('scopes reads to the viewer\'s installations', async () => {
      const ownerId = await makeUser()
      const intruderId = await makeUser()
      const ownerInstallation = await makeInstallation(ownerId, randomInstallationId())

      const ownerView = await listInstallationsForViewer(viewer(ownerId))
      expect(ownerView.map((i) => i.id)).toContain(ownerInstallation)

      const intruderView = await listInstallationsForViewer(viewer(intruderId))
      expect(intruderView.map((i) => i.id)).not.toContain(ownerInstallation)
    })

    it('refuses to return someone else\'s installation by id', async () => {
      const ownerId = await makeUser()
      const intruderId = await makeUser()
      const numericInstallationId = randomInstallationId()
      await makeInstallation(ownerId, numericInstallationId)

      await expect(
        getInstallationForViewer(numericInstallationId, viewer(intruderId)),
      ).resolves.toBeNull()
    })
  })

  describe('getInstallationByGithubId / deleteInstallationByGithubId', () => {
    it('round-trips a numeric id and cascades to repos on delete', async () => {
      const userId = await makeUser()
      const numericInstallationId = randomInstallationId()
      const installationRowId = await makeInstallation(userId, numericInstallationId)
      const repo = await makeRepo(installationRowId, 'cascade')

      const fetched = await getInstallationByGithubId(numericInstallationId)
      expect(fetched?.id).toBe(installationRowId)

      await deleteInstallationByGithubId(numericInstallationId)
      const stillThere = await db.query.githubRepos.findFirst({
        where: eq(githubRepos.id, repo!.id),
      })
      expect(stillThere).toBeUndefined()
    })
  })

  describe('deleteReposByGithubIds', () => {
    it('removes only the named repos from the installation', async () => {
      const userId = await makeUser()
      const installationRowId = await makeInstallation(userId, randomInstallationId())
      const keep = await makeRepo(installationRowId, 'keep')
      const drop = await makeRepo(installationRowId, 'drop')

      await deleteReposByGithubIds(installationRowId, [drop!.githubId])

      const survivors = await db.query.githubRepos.findMany({
        where: eq(githubRepos.installationId, installationRowId),
      })
      const survivorIds = survivors.map((r) => r.id)
      expect(survivorIds).toContain(keep?.id)
      expect(survivorIds).not.toContain(drop?.id)
    })

    it('is a no-op for an empty list', async () => {
      const userId = await makeUser()
      const installationRowId = await makeInstallation(userId, randomInstallationId())
      const keep = await makeRepo(installationRowId, 'no-op')

      await deleteReposByGithubIds(installationRowId, [])

      const survivors = await db.query.githubRepos.findMany({
        where: eq(githubRepos.installationId, installationRowId),
      })
      expect(survivors.map((r) => r.id)).toEqual([keep?.id])
    })
  })

  describe('cleanup', () => {
    it('cascades to github_installations and github_repos when a user is deleted', async () => {
      const userId = await makeUser()
      const installationRowId = await makeInstallation(userId, randomInstallationId())
      await makeRepo(installationRowId, 'orphan')

      await db.delete(users).where(eq(users.id, userId))
      createdUserIds.splice(createdUserIds.indexOf(userId), 1)

      const leftoverInstallations = await db.query.githubInstallations.findMany({
        where: eq(githubInstallations.userId, userId),
      })
      expect(leftoverInstallations).toEqual([])
    })
  })
})

function randomInstallationId(): number {
  return Math.floor(Math.random() * 1e10) + 1
}
