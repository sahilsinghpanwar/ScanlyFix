/**
 * GitHub App installations and the repos they expose.
 *
 * An installation is a SCOPED, REVOCABLE grant the user made at install time.
 * It is not a token, and the token itself never lives here — the worker mints
 * a short-lived installation access token per scan. The only durable thing on
 * the row is GitHub's installation id, which is what a token exchange keys on.
 *
 * Same Viewer-based access rule as everywhere else: a function that reads
 * another account's data takes a Viewer, and the only anonymous path is the
 * one with nothing to leak (and there is none — repo scans always belong to a
 * signed-in user).
 */

import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  githubInstallations,
  githubRepos,
  type GithubInstallation,
  type GithubRepo,
  type NewGithubInstallation,
  type NewGithubRepo,
} from '../schema.ts'
import type { Viewer } from './viewer.ts'

export interface NewInstallationInput {
  installationId: number
  accountLogin: string
  accountType: string
}

/**
 * Record an installation the user just completed.
 *
 * If we already have this installation id (the user reinstalled, or the same
 * GitHub account installed twice), we keep the existing ROW and return it — an
 * installation is a fact about a GitHub grant, not a session, and re-issuing a
 * row on a re-install would orphan every scan and repo in the cascade delete.
 *
 * Ownership, however, follows the person who JUST completed the install.
 * GitHub hands back the SAME installation id when the same GitHub account is
 * installed again, and a person who signs in with a different email is a
 * different app user (different users.id). Without reassignment, someone who
 * installed the app under one address and later signs in with another — the
 * classic "I logged in again and my repo is gone" — would see an empty feed
 * forever: the row exists, it is just keyed to the other account, and GitHub
 * keeps reusing the same installation id so a fresh install never creates a
 * new row either.
 */
export async function upsertInstallation(
  viewer: Viewer,
  input: NewInstallationInput,
): Promise<GithubInstallation | null> {
  if (viewer.kind !== 'user') return null

  const existing = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, input.installationId),
  })
  if (existing) {
    if (existing.userId !== viewer.userId) {
      const [updated] = await db
        .update(githubInstallations)
        .set({
          userId: viewer.userId,
          // The account the grant actually belongs to, refreshed from GitHub
          // in case the same installation was reached through a rename.
          accountLogin: input.accountLogin,
          accountType: input.accountType,
        })
        .where(eq(githubInstallations.id, existing.id))
        .returning()
      return updated ?? existing
    }
    return existing
  }
  const row: NewGithubInstallation = {
    userId: viewer.userId,
    installationId: input.installationId,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
  }
  const inserted = await db.insert(githubInstallations).values(row).returning()
  return inserted[0] ?? null
}

/** All installations for an account, newest first. */
export async function listInstallationsForViewer(viewer: Viewer): Promise<GithubInstallation[]> {
  if (viewer.kind !== 'user') return []
  return db.query.githubInstallations.findMany({
    where: eq(githubInstallations.userId, viewer.userId),
    orderBy: desc(githubInstallations.createdAt),
  })
}

/** A single installation by id, only if the viewer owns it. */
export async function getInstallationForViewer(
  installationId: number,
  viewer: Viewer,
): Promise<GithubInstallation | null> {
  if (viewer.kind !== 'user') return null
  const row = await db.query.githubInstallations.findFirst({
    where: and(
      eq(githubInstallations.installationId, installationId),
      eq(githubInstallations.userId, viewer.userId),
    ),
  })
  return row ?? null
}

export interface NewRepoInput {
  installationId: string
  owner: string
  name: string
  fullName: string
  defaultBranch: string
  private: boolean
  githubId: number
}

/**
 * Idempotent on (installationId, owner, name) — re-running the repo-listing
 * step over the same grant never creates duplicate rows. The unique index
 * installed at the schema level is the actual safety net; this just makes
 * the no-op explicit at the call site.
 */
export async function upsertRepo(input: NewRepoInput): Promise<GithubRepo | null> {
  const existing = await db.query.githubRepos.findFirst({
    where: and(
      eq(githubRepos.installationId, input.installationId),
      eq(githubRepos.owner, input.owner),
      eq(githubRepos.name, input.name),
    ),
  })
  if (existing) return existing

  const row: NewGithubRepo = {
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    fullName: input.fullName,
    defaultBranch: input.defaultBranch,
    private: input.private,
    githubId: input.githubId,
  }
  const inserted = await db.insert(githubRepos).values(row).returning()
  return inserted[0] ?? null
}

/** Repos owned by an installation, newest first. */
export async function listReposForInstallation(installationId: string): Promise<GithubRepo[]> {
  return db.query.githubRepos.findMany({
    where: eq(githubRepos.installationId, installationId),
    orderBy: desc(githubRepos.createdAt),
  })
}

/** All repos visible to the viewer across every installation. */
export async function listReposForViewer(viewer: Viewer): Promise<GithubRepo[]> {
  if (viewer.kind !== 'user') return []
  return db
    .select({ repo: githubRepos })
    .from(githubRepos)
    .innerJoin(githubInstallations, eq(githubInstallations.id, githubRepos.installationId))
    .where(eq(githubInstallations.userId, viewer.userId))
    .orderBy(desc(githubRepos.createdAt))
    .then((rows) => rows.map((r) => r.repo))
}

/**
 * A repo the user has stored, looked up by its row id. Returns null when the
 * viewer does not own it, so a caller cannot accidentally scan a repo that
 * belongs to someone else by guessing a row id.
 */
export async function getRepoForViewer(
  repoId: string,
  viewer: Viewer,
): Promise<GithubRepo | null> {
  if (viewer.kind !== 'user') return null
  const row = await db
    .select({ repo: githubRepos })
    .from(githubRepos)
    .innerJoin(githubInstallations, eq(githubInstallations.id, githubRepos.installationId))
    .where(and(eq(githubRepos.id, repoId), eq(githubInstallations.userId, viewer.userId)))
    .limit(1)
  return row[0]?.repo ?? null
}

/**
 * The repo + the numeric installation id it belongs to, looked up together.
 *
 * The repo row alone does not carry the installation id (the relation is one
 * repo → one installation), and the API route that triggers a scan needs both
 * to build the Inngest event. Returning them as a tuple is cheaper than a
 * second query in the hot path and keeps the access check in one place.
 */
export interface RepoWithInstallation {
  repo: GithubRepo
  installationId: number
}

export async function getRepoWithInstallationForViewer(
  repoId: string,
  viewer: Viewer,
): Promise<RepoWithInstallation | null> {
  if (viewer.kind !== 'user') return null
  const rows = await db
    .select({ repo: githubRepos, installationId: githubInstallations.installationId })
    .from(githubRepos)
    .innerJoin(githubInstallations, eq(githubInstallations.id, githubRepos.installationId))
    .where(and(eq(githubRepos.id, repoId), eq(githubInstallations.userId, viewer.userId)))
    .limit(1)
  const row = rows[0]
  return row ? { repo: row.repo, installationId: row.installationId } : null
}

/**
 * Look up an installation by GitHub's numeric id (without a Viewer). The webhook
 * is the canonical caller: GitHub never tells us which application user owns an
 * installation, only the installation itself, and we resolve the application
 * user through the row we recorded when the user clicked Install.
 */
export async function getInstallationByGithubId(
  installationId: number,
): Promise<GithubInstallation | null> {
  const row = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
  })
  return row ?? null
}

/**
 * The product caps every account at ONE connected repository. This is the
 * enforcement half; which single repo survives is chosen by the caller (the
 * GitHub callback, via chooseConnectedRepo) — this query deletes every OTHER
 * github_repos row across ALL of the user's installations, so a re-install
 * under a new installation id can never resurrect a second repo.
 *
 * Deletion cascades to that repo's scans and findings. That is the cost of
 * the cap and it is accepted deliberately: keeping orphaned scans for repos
 * the account no longer connects would show data the grant no longer covers.
 */
export async function deleteOtherReposForUser(viewer: Viewer, keepRepoId: string): Promise<void> {
  if (viewer.kind !== 'user') return
  const installationIds = db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, viewer.userId))
  await db
    .delete(githubRepos)
    .where(and(inArray(githubRepos.installationId, installationIds), ne(githubRepos.id, keepRepoId)))
}

/**
 * Remove an installation row by GitHub's numeric id. Cascades to its repos
 * (and their scans/findings) via the FK on `github_installations`. Used by
 * `installation.deleted` webhooks.
 */
export async function deleteInstallationByGithubId(installationId: number): Promise<void> {
  await db.delete(githubInstallations).where(eq(githubInstallations.installationId, installationId))
}

/**
 * Remove specific repos from an installation by GitHub's numeric repo id.
 * Used by `installation_repositories.removed` webhooks, which carry the
 * deleted repos and not the survivors.
 */
export async function deleteReposByGithubIds(
  installationRowId: string,
  repoIds: number[],
): Promise<void> {
  if (repoIds.length === 0) return
  await db
    .delete(githubRepos)
    .where(and(eq(githubRepos.installationId, installationRowId), inArray(githubRepos.githubId, repoIds)))
}
