import { NextResponse } from 'next/server'
import { getViewer } from '@/lib/authz.ts'
import { chooseConnectedRepo } from '@/lib/repo-cap.ts'
import { getInstallationAccount, listInstallationRepos } from '@/lib/github-app.ts'
import {
  deleteOtherReposForUser,
  listReposForViewer,
  upsertInstallation,
  upsertRepo,
} from '@scanlyfix/db'

export const runtime = 'nodejs'

function fail(error: string, status: number, origin: string, next: string) {
  return NextResponse.redirect(new URL(`/feed?error=${encodeURIComponent(error)}`, origin))
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const installationIdRaw = url.searchParams.get('installation_id')
  const setupAction = url.searchParams.get('setup_action')
  const next = url.searchParams.get('next') ?? '/feed'

  if (!installationIdRaw) return fail('missing-installation', 400, url.origin, next)

  // An OAuth `code` beside installation_id means the GitHub App still has
  // "Request user authorization (OAuth) during installation" enabled. For
  // that flow GitHub ignores the redirect_url the Connect button built and
  // sends the user to the app's FIRST configured Callback URL instead — which
  // strands every origin that isn't listed first. The app never uses user
  // tokens (installation tokens only), so that setting should stay off.
  if (url.searchParams.get('code')) {
    console.warn(
      '[github/callback] OAuth code present: the GitHub App requests user authorization during installation, so GitHub ignored redirect_url and used its first configured Callback URL.',
    )
  }

  const installationId = Number(installationIdRaw)
  if (!Number.isFinite(installationId)) return fail('invalid-installation', 400, url.origin, next)

  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    /*
     * The install is not lost with the session. The same route runs again
     * after sign-in — it is idempotent — so `next` carries the installation
     * id straight through /login and the connect completes without the user
     * finding the button twice. A same-origin path with a query, exactly the
     * shape safeNextPath exists to allow.
     */
    const resume = new URL('/api/github/callback', url.origin)
    resume.searchParams.set('installation_id', String(installationId))
    if (setupAction) resume.searchParams.set('setup_action', setupAction)
    const login = new URL('/login', url.origin)
    login.searchParams.set('next', `${resume.pathname}${resume.search}`)
    login.searchParams.set('error', 'github-connect-requires-signin')
    return NextResponse.redirect(login)
  }

  try {
    const account = await getInstallationAccount(installationId)
    const installation = await upsertInstallation(viewer, {
      installationId,
      accountLogin: account.login,
      accountType: account.type,
    })
    if (!installation) throw new Error('Could not record installation')

    const repos = await listInstallationRepos(installationId)

    /*
     * One repository per account. chooseConnectedRepo picks WHICH one survives
     * (existing connected repo if the grant still covers it, else the first
     * granted); the cap's delete removes every other repo row across the
     * account's installations. Kept a no-op when the grant carries no repos —
     * an install that selected nothing must not prune anything.
     */
    const existing = await listReposForViewer(viewer)
    // Map GitHub's `id` onto the cap's `githubId` match key; the spread keeps
    // every other InstallationRepo field the upsert below needs.
    const granted = repos.map((repo) => ({ ...repo, githubId: repo.id }))
    const chosen = chooseConnectedRepo(existing, granted)
    if (chosen) {
      const alreadyStored = existing.find((repo) => repo.githubId === chosen.repo.id)
      const row = alreadyStored ?? (await upsertRepo({
        installationId: installation.id,
        owner: chosen.repo.owner.login,
        name: chosen.repo.name,
        fullName: chosen.repo.full_name,
        defaultBranch: chosen.repo.default_branch,
        private: chosen.repo.private,
        githubId: chosen.repo.id,
      }))
      if (row) await deleteOtherReposForUser(viewer, row.id)
    }

    const destination = new URL('/feed#repositories', url.origin)
    if (setupAction) destination.searchParams.set('setup_action', setupAction)
    return NextResponse.redirect(destination)
  } catch (error) {
    console.error('[github/callback] could not finish install', error)
    return fail('github-install-failed', 500, url.origin, next)
  }
}
