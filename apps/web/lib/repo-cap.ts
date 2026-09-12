/**
 * The one-repository rule: every account connects exactly ONE GitHub repo.
 *
 * The cap lives in the GitHub callback, and this function owns the ONLY
 * interesting decision in it — which repo survives when an install grants
 * several. The rule is stability-first:
 *
 *   1. If the account already has a repo connected AND the fresh grant still
 *      includes it, keep it. A re-install, an app update, an extra org grant —
 *      none of those should silently swap the repo the account's scans hang
 *      off. Swapping deletes history (the cap's prune cascades scans), so it
 *      must be an explicit act, not a side effect.
 *   2. Otherwise take the first repo of the freshly granted set. GitHub's
 *      installation-repository listing is deterministic, so this is
 *      reproducible, and a first-ever connect has no existing repo to prefer.
 *
 * Pure and dependency-free so the decision is unit-testable without GitHub or
 * a database. The caller does the I/O: find-or-upsert the chosen row, then
 * deleteOtherReposForUser(viewer, chosen.id) to enforce the cap.
 */

export interface CapCandidate {
  /** GitHub's numeric repo id — stable across renames, so it is the match key. */
  githubId: number
}

export interface ChosenRepo<T extends CapCandidate> {
  repo: T
  /** True when the grant still contains the account's existing connected repo. */
  keptExisting: boolean
}

/**
 * Pick the one repo to keep, or null when the grant carries no repositories
 * (nothing to store; the caller keeps whatever exists untouched — an account
 * with a grant that has zero repos is a connect that selected nothing).
 */
export function chooseConnectedRepo<T extends CapCandidate>(
  existing: readonly CapCandidate[],
  granted: readonly T[],
): ChosenRepo<T> | null {
  if (granted.length === 0) return null

  const existingIds = new Set(existing.map((repo) => repo.githubId))
  const stable = granted.find((repo) => existingIds.has(repo.githubId))
  if (stable) return { repo: stable, keptExisting: true }

  const first = granted[0]
  if (first === undefined) return null
  return { repo: first, keptExisting: false }
}
