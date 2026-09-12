# Redirect configuration runbook

Why sign-in and GitHub-connect sometimes bounce to `localhost`, and the exact
dashboard settings that stop it. The application code is already origin-aware —
the login form builds its OAuth redirect from `window.location.origin`, and the
feed's Connect button builds the GitHub App redirect from the request's own
`Host` / `X-Forwarded-Host` (see `apps/web/lib/github-connect.ts`). When a
redirect still lands on the wrong origin, the cause is one of the two provider
dashboards below, because **cookies are per-origin** and both localhost and
production talk to the same database.

## Symptom 1 — clicking sign-in on scanlyfix.com lands on localhost

The OAuth hop is: `scanlyfix.com/login` → Supabase authorize → provider
(GitHub/Google) → Supabase `/auth/v1/callback` → **back to the app**. The last
hop uses the `redirectTo` the app sent (always the origin you clicked from) —
but only if that URL is on the Supabase project's allowlist. When Supabase
cannot use it, it falls back to the project's **Site URL**, and a Site URL left
at the default `http://localhost:3000` is exactly the "redirects to localhost"
bug.

Fix in the **Supabase dashboard** (Authentication → URL Configuration):

1. **Site URL** = `https://scanlyfix.com` (the production origin, no path).
2. **Redirect URLs** must contain at least:
   - `https://scanlyfix.com/auth/callback`
   - `https://www.scanlyfix.com/auth/callback` (if the www host is served)
   - `http://localhost:3000/auth/callback` (so local development works — the
     same project serves both, and the PKCE verifier cookie is scoped to the
     origin the flow started on)
3. Keep `SUPABASE_REDIRECT_ALLOWLIST` in the deployment environment mirroring
   that list; the proxy logs a warning at boot when it drifts.

Also check each provider's own callback (Authentication → Providers):

- **GitHub** provider: the GitHub OAuth App's *Authorization callback URL* must
  be `https://mxjrcpkfechlylaiaape.supabase.co/auth/v1/callback` (Supabase
  shows the exact value on the provider page). A localhost value here makes
  GitHub itself refuse or misroute the hop.
- **Google** provider: the authorized redirect URI in Google Cloud Console
  must be `https://mxjrcpkfechlylaiaape.supabase.co/auth/v1/callback`.

## Symptom 2 — connecting GitHub sends you to scanlyfix.com (from localhost) or to localhost (from production)

The Connect GitHub button on `/feed` sends GitHub
`redirect_url=<current-origin>/api/github/callback?next=%2Ffeed`. GitHub only
follows a `redirect_url` that matches the **GitHub App's configured Callback
URLs**. With the app's settings wrong you get the mirror-image mess:

- From **localhost**: `http://localhost:3000/api/github/callback` is not in the
  app's Callback URLs → GitHub ignores it and uses the app's first/default
  callback (`https://scanlyfix.com/api/github/callback`) → your localhost
  session cookie does not exist there → `/login?error=github-connect-requires-signin`
  on the production domain.
- From **production**: if `http://localhost:3000/api/github/callback` is listed
  *first* and **"Request user authorization (OAuth) during installation"** is
  checked, GitHub ignores the per-origin `redirect_url` entirely and sends
  everyone to the *first* callback URL — localhost.

Fix in **GitHub → Settings → Developer settings → GitHub Apps → ScanlyFix**:

1. **Callback URL** list — add every origin the app is used from, production
   first (GitHub allows up to 10):
   - `https://scanlyfix.com/api/github/callback`
   - `https://www.scanlyfix.com/api/github/callback`
   - `http://localhost:3000/api/github/callback`
2. **Uncheck "Request user authorization (OAuth) during installation."** The
   app never uses user tokens — scans mint short-lived installation tokens —
   so this setting only gives GitHub a reason to ignore our `redirect_url`.
   (The callback route logs a warning whenever it sees the OAuth `code` this
   setting produces, so a regression is visible in the logs.)
3. **Webhook URL** = `https://scanlyfix.com/api/webhooks/github` with the same
   secret as `GITHUB_WEBHOOK_SECRET` in the deployment environment.

## Why /feed then "forgets" the connection

The installation row is written by `/api/github/callback` — on the origin the
browser lands on, using the session cookie of that origin. When the redirect is
misrouted, the callback runs signed-out, the install is dropped, and the feed
shows Connect GitHub forever. Fix the redirect configuration above and the
persistence already in place works: installations are keyed to the account that
completed the install and are reassigned when the same GitHub installation id
is completed again from a different account.

## Verify

Run `pnpm audit:redirects` from the repo root. It checks the environment side
(APP_URL vs allowlist, GitHub App env presence) and prints the dashboard steps
above for anything it cannot see from code.
