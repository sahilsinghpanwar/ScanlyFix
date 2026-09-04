# Deploying ScanlyFix

Four things ship, and they are independent: the **web app** (Next.js), the
**scanner** (a headless Chromium service), **Convex** (identity only), and
**Postgres** (everything else). The web app is the only one a visitor talks to.

Work through this in order. Each section says what breaks if it is skipped,
because most of these fail silently rather than loudly.

---

## 1. Postgres — migrations

Run before the new code serves traffic, not after:

```sh
DATABASE_URL=<production url> pnpm db:deploy
```

Use `db:deploy`, not `db:migrate`. `db:migrate` is drizzle-kit, which is a
devDependency and is absent from a production install; `db:deploy` uses only
`drizzle-orm` and `pg`, which the app needs at runtime anyway. It also takes a
Postgres advisory lock, so several instances of the same release booting at
once do not race to create the same table.

**Skipped:** the first sign-in fails on a missing `auth_subject` column, and
every scan 500s.

---

## 2. Web app — environment

Copy `.env.example` and fill it in. Three are load-bearing beyond the obvious:

| Variable | Why it matters in production |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | The deployed origin. Feeds `metadataBase`, `robots.txt`, `sitemap.xml` and Razorpay's return URL. Left unset it defaults to `http://localhost:3000`, and every one of those points at a machine nobody can reach. |
| `IP_HASH_SALT` | A long random string. Without a salt an IPv4 hash is reversible in minutes — there are only four billion of them. |
| `INNGEST_SIGNING_KEY` | Its presence is what switches Inngest out of dev mode. Set it in production and **never** locally. |

`SCANLYFIX_SCANNER_URL` / `SCANLYFIX_SCANNER_TOKEN` are optional but gate real
features: without them deep scans skip the rendered-DOM and accessibility
checks, and PDF export fails while CSV and Markdown keep working.

### Verify

`GET /api/health` returns `200 {"status":"ok"}` when the required variables are
present and `503 {"status":"degraded", "detail": "…"}` when they are not,
naming the missing variable without printing its value. Point the platform's
health check at it.

---

## 3. Supabase — identity

Supabase holds **only** identity. Users, scans, projects and subscriptions
live in Postgres.

1. Confirm the production project exists at the Supabase dashboard and the
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   environment variables are set to its values.
2. In the Supabase dashboard, register the production redirect URL at
   **Authentication → URL Configuration → Additional Redirect URLs**:
   `https://<your domain>/auth/callback`
3. In **Authentication → Providers**, enable Google and GitHub and paste the
   OAuth credentials. For each, register the Supabase-side callback URL
   Supabase shows beneath the toggle (the one beginning with the project's
   `*.supabase.co/auth/v1/callback?provider=…`) on the provider's own
   developer console.

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for the full list, and note the
rotation warning at the top of it.

**Skipped:** all three sign-in methods fail. Nothing else in the product is
affected — anonymous scanning still works.

---

## 4. Scanner

`apps/scanner/Dockerfile` builds it. It needs `SCANLYFIX_SCANNER_TOKEN` — a shared
secret you choose — and refuses to start without one, because it drives a real
browser at any URL it is handed. Give the web app the same token and the
service's internal URL.

Keep it off the public internet if you can. It is an SSRF engine by design.

**Skipped:** deep scans return fewer findings and PDF export fails. Both
degrade rather than break.

---

## 5. Inngest

Scans run on a queue and monitors run on a cron; both are Inngest.

1. Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` from the dashboard.
2. After the first deploy, register the app's endpoint — `https://<your
   domain>/api/inngest` — in the Inngest dashboard.

**Skipped:** queued scans sit at `queued` forever and no monitor ever runs.
The UI shows a scan that never finishes, with no error anywhere.

---

## 5b. Fixes — the AI fix-prompt tier

`apps/fixes` turns one finding into the prompt that fixes it. It needs two
secrets, both required — the process refuses to start without either:

- `OPENROUTER_API_KEY` — held by THIS service only. The web app never sees it.
- `SCANLYFIX_FIXES_TOKEN` — a shared secret you choose (`openssl rand -hex 24`),
  given to the web app as `SCANLYFIX_FIXES_TOKEN` alongside
  `SCANLYFIX_FIXES_URL` (the service's internal URL; default port 8082).

`FIXES_MODEL` overrides the model — it defaults to `minimax/minimax-m3:free`
on OpenRouter. Generation failures surface in the UI as a retry button, so a
throttled free tier degrades to "press again", not to a broken feature.

**Skipped:** every Fix button answers "fix prompts are not configured". Nothing
else is affected.

---

## 6. Razorpay

Point the webhook at `https://<your domain>/api/webhooks/razorpay` and
subscribe it to the `subscription.*` events. `RAZORPAY_WEBHOOK_SECRET` is a
different secret from the API one.

Run `pnpm razorpay:check` first — Razorpay returns the same "Unauthorized"
body for wrong credentials and for a product the account has not been enabled
for, and that script tells the two apart.

**Skipped:** payments succeed and nobody is ever upgraded.

---

## Platform notes

Nothing in the repo is tied to a host. Two shapes work:

- **Vercel** — set the project's root directory to `apps/web`. Run §1 as a
  separate step; do not put it in the build command, or every preview
  deployment migrates the production database.
- **A container** — set `output: 'standalone'` in `apps/web/next.config.ts`
  first. Without it the standalone server bundle is not emitted and the image
  has to carry the whole monorepo.

---

## After the first deploy

```sh
curl -s https://<domain>/api/health          # {"status":"ok", ...}
curl -s https://<domain>/robots.txt          # sitemap line points at <domain>
curl -s https://<domain>/sitemap.xml         # both URLs are absolute and correct
```

Then sign in once with each of Google, GitHub and an emailed code. The sign-in
path is the one that spans all four systems, so it is the check worth doing by
hand.
