# Deep Scan Integrations — Implementation Guide

**For:** ScanlyFix
**Scope:** Connecting GitHub, GitLab, Supabase, and Terraform/IaC sources for authenticated "deep scans," on top of the existing passive/read-only web scanner.
**Status:** Architecture + build plan; partially implemented (see below).

---

## 0. Implementation status (updated 2026-09-13)

What has shipped since this plan was written, mapped to the build order in §10:

1. **Connections table + credential vault + revoke flow (§3, §7) — DONE (v1).**
   `connections`, `connection_secrets` and `credential_access_log` tables live in
   `packages/db/src/schema.ts` (migration `0013_mixed_gamora.sql`, applied). The vault is
   envelope encryption without a KMS dependency: per-record AES-256-GCM data key wrapped by a
   root key held in `CONNECTION_ENCRYPTION_KEY` (`apps/web/lib/credentials-vault.ts`). Every
   decrypt writes a `credential_access_log` row. Revoke (`DELETE /api/connections/[id]`)
   hard-deletes the sealed secret and marks the grant revoked. Swapping the root key source
   for a real KMS later touches one function.
2. **GitHub App (§4) — already existed** before this plan (installations, repos,
   `github-scanner` worker, webhooks). One change: **every account is now capped at ONE
   connected repository** (product decision). `chooseConnectedRepo` keeps the account's
   existing repo when the fresh grant still covers it, otherwise stores the first granted
   repo; `deleteOtherReposForUser` prunes the rest (cascades that repo's scans).
   Accounts with multiple stored repos are re-capped the next time they complete a connect —
   there is deliberately no destructive prune of existing data at deploy time.
4. **Supabase Level 1 (§5.1 first tier, §5.2) — DONE (v1).** Connect flow
   (`POST /api/connections`) validates the URL down to a real `*.supabase.co` host, REFUSES a
   service-role key by name (JWT `role` claim or `sb_secret_` prefix), probes the project,
   then seals the publishable key into the vault. Scan (`POST /api/connections/[id]/scan`)
   runs: public auth settings exposure, REST OpenAPI schema exposure, and per-table
   anon-readability (the RLS-off check) — evidence-first findings stored as a jsonb snapshot
   on the connection and rendered on `/feed`. Buckets and Management-API checks need Level 2
   and are not attempted with an anon key.
5. **GitLab, IaC scanners, webhook re-scans, auto-fix, Level 2 (scoped Postgres role)** —
   not built; the plan below still describes them.

Redirect misconfiguration (sign-in/connect bouncing between `localhost` and the production
domain) is a dashboard problem, not a code problem — the app is origin-aware. Runbook:
`docs/REDIRECT-CONFIG.md`; preflight: `pnpm audit:redirects`.

---


## 1. Why this is a different product tier, not a bigger scan

Your current engine's entire trust story is: *a scan is a read, nothing is logged into, nothing changes state, and the two checks that touch a backend only fire on a domain you've verified you own.* That constraint is what lets you scan anyone's URL with zero friction.

Connected sources break that constraint on purpose — you're now asking users to hand you a GitHub App install, a Supabase service-role key, or read access to their Terraform state. That's a different trust tier, and it needs its own gate, not an extension of the existing one. Concretely: **every deep-scan capability should require an explicit, scoped, revocable connection object**, separate from the anonymous URL scan flow. Don't let a verified domain silently unlock repo access — a domain and a GitHub org are different ownership claims.

This doc treats each integration as: (1) how the user connects it, (2) what you actually scan once connected, (3) what tooling does the scanning, (4) how credentials are stored, (5) how it plugs into your existing findings/monitoring model.

---

## 2. Core architecture additions

```
┌─────────────────────────────────────────────────────────────┐
│  Existing: URL scan engine (Next.js + Inngest + Supabase)    │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │  Connections API    │  new
                    │  (OAuth/App/token)  │
                    └─────────┬─────────┘
                              │
                ┌─────────────┼─────────────┐
                │             │             │
        ┌───────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
        │ GitHub App    │ │ GitLab   │ │ Supabase   │
        │ installation  │ │ OAuth    │ │ project    │
        │ tokens        │ │ tokens   │ │ conn.      │
        └───────┬──────┘ └────┬─────┘ └─────┬──────┘
                │             │             │
                └─────────────┼─────────────┘
                              │
                      ┌───────▼────────┐
                      │ Credential Vault│  new — encrypted,
                      │ (envelope enc.) │  never touches app DB in plaintext
                      └───────┬────────┘
                              │
                      ┌───────▼────────┐
                      │ Scan Job Queue  │  Inngest, extended
                      └───────┬────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
      ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼───────┐
      │ Sandboxed     │ │ Supabase    │ │ IaC scanner  │
      │ repo scanner  │ │ API scanner │ │ (Terraform)  │
      │ (Docker/gVisor)│ │ (mgmt API) │ │              │
      └───────┬──────┘ └──────┬──────┘ └──────┬───────┘
              └───────────────┼───────────────┘
                              │
                      ┌───────▼────────┐
                      │ Findings store  │  existing schema,
                      │ (extended)      │  extended pillar: "Infra"
                      └────────────────┘
```

New pieces you don't have today: a **Connections** table/service, a **Credential Vault**, a **sandboxed execution layer** for anything that clones code or runs scanners, and a new findings pillar (call it `infra` or `supply-chain`) alongside your existing six.

---

## 3. Credential vault (build this before any integration)

Every integration below hands you a secret: a GitHub App private key exchange, a GitLab PAT, a Supabase service-role key. None of these should ever sit in plaintext in your primary Postgres/Supabase instance, even encrypted-at-rest by the platform, because a single SQL injection or leaked service-role key on *your* side becomes a breach of every customer you monitor.

**Pattern: envelope encryption with a dedicated secrets store.**

- Use a KMS (AWS KMS, GCP KMS, or Supabase Vault extension — Supabase actually ships `pgsodium`/Vault for exactly this) to hold a root key.
- Each stored credential is encrypted with a per-record data key, which is itself encrypted by the KMS root key (envelope encryption). Store only ciphertext + encrypted data key in your DB.
- Decrypt only inside the scan worker process, at the moment of use, in memory, never logged.
- Every credential row carries: `owner_user_id`, `provider`, `scopes_granted`, `created_at`, `last_used_at`, `revoked_at`.
- Build the **revoke** path first, not last. A "disconnect GitHub" button that actually calls the provider's token-revocation endpoint and hard-deletes the vault record is a prerequisite for asking anyone to connect anything.
- Log every decrypt event to an audit table (`credential_id`, `scan_run_id`, `timestamp`) — this is what you'll show an enterprise customer's security team when they ask "who touched our service-role key and when."

This is the single most important section in this document. Get the vault and revocation right before wiring up a single provider — it's the thing that turns "cool feature" into "thing procurement will actually approve."

---

## 4. GitHub integration

### 4.1 Connection model: GitHub App, not OAuth

Use a **GitHub App**, not a plain OAuth App. Reasons:
- Installations are scoped to specific repos the user picks, not "all repos this user can see" (which is what OAuth + `repo` scope gives you).
- You get short-lived installation tokens (1 hour) minted on demand from your app's private key, rather than a long-lived user token sitting in your DB.
- Users can see and manage the installation from their GitHub org settings independently of your app — this matters a lot for trust and for enterprise approval.

**Flow:**
1. Register a GitHub App in your GitHub Developer settings. Request the minimum permissions:
   - `Contents: Read-only` (to read files/clone)
   - `Metadata: Read-only` (required baseline)
   - `Secret scanning alerts: Read-only` *if* you want to also surface GitHub's own secret-scanning results rather than duplicate them
   - Do **not** request `Contents: Write`, `Administration`, or anything write-capable for v1. You are a scanner, not a bot that opens PRs — at least not yet (see §8 on auto-fix).
2. User clicks "Connect GitHub" → redirected to GitHub's app installation page → picks org + repos → GitHub redirects back with an `installation_id`.
3. Store `installation_id` + `account_login` + selected repo list in your `connections` table. No token is stored yet.
4. At scan time, your backend uses the App's private key (held in the vault, one per app not per user) to mint a short-lived JWT, exchanges it for an installation access token via `POST /app/installations/{installation_id}/access_tokens`, uses that token for the scan, and discards it.

### 4.2 What you actually scan

Don't reinvent scanners — orchestrate existing, well-maintained open-source ones and normalize their output into your findings schema. This is where "borrow the pattern from Strix, not the code" applies directly.

| Check category | Tool | Why this one |
|---|---|---|
| Leaked secrets (API keys, tokens in history/current files) | [Gitleaks](https://github.com/gitleaks/gitleaks) | Fast, MIT-licensed, huge rule set, easy JSON output |
| Dependency vulnerabilities (CVEs in package manifests/lockfiles) | [OSV-Scanner](https://github.com/google/osv-scanner) (Google) | Language-agnostic, no API key needed, feeds from OSV.dev |
| Static code security issues (SAST) | [Semgrep](https://github.com/semgrep/semgrep) OSS rules | Broad language support, community + OWASP rule packs |
| Infra-as-code misconfig (if `.tf`, `.yaml` for k8s, Dockerfiles present in repo) | [Checkov](https://github.com/bridgecrewio/checkov) or [Trivy](https://github.com/aquasecurity/trivy) | Covers Terraform, CloudFormation, k8s manifests, Dockerfiles in one tool |
| License / SBOM | [Trivy](https://github.com/aquasecurity/trivy) or Syft | Nice-to-have, easy add-on once the pipeline exists |

**Execution model:**
```
1. Mint installation token
2. git clone --depth 1 <authenticated-url> into an ephemeral, network-restricted container
3. Run each scanner as a subprocess inside that container, writing JSON to a shared volume
4. Parse each tool's JSON output → map to your Finding schema (severity, evidence, location, fix-prompt text)
5. Destroy the container. Nothing persists beyond the findings.
6. Delete the installation token (or just let it expire — it's already short-lived)
```

Run this in a **sandboxed, network-egress-restricted container per scan** (gVisor, Firecracker/Kata, or at minimum a locked-down Docker container with no outbound access except the git clone and package-registry lookups the scanners need). You are running arbitrary customer code's dependency resolution and cloning arbitrary repos — treat it with the same suspicion you'd want if you were the customer.

### 4.3 Mapping to your existing "fix prompt" output

This is actually where you have an edge over generic scanners: you already produce one fix-prompt per scan grouped by *where the change lands*. Extend the same grouping logic:
- Secrets found → group as "rotate immediately," same urgency logic you already apply to leaked credentials in the web scanner.
- Dependency CVEs → group by manifest file (`package.json`, `requirements.txt`, etc.), one edit per file.
- IaC misconfig → group by `.tf` module/file.
- SAST findings → group by source file.

### 4.4 GitLab

Same shape, different auth: GitLab doesn't have a first-class "GitHub App" equivalent with the same installation-token ergonomics, so use:
- **OAuth 2.0 with PKCE** for user-authorized connections, scoped to `read_repository` and `read_api` only.
- Or, for self-hosted GitLab instances, let the user supply a **Project Access Token** (GitLab's repo-scoped, non-personal token type) with `read_repository` scope — this is the closer analog to GitHub App's per-repo scoping and is what you should push users toward, since personal access tokens are broader than you need.
- Cloning and scanning pipeline is identical to §4.2 once you have a valid token.

---

## 5. Supabase integration

This is the one your site's own "Safety" section already gestures at ("the two checks that touch someone else's infrastructure — Supabase row-level security, Firebase rules — receive the capability only on a domain you have verified"). You're extending that from "one check, gated by domain verification" to "a full connected scan, gated by an explicit connection."

### 5.1 Connection model

Two levels of access, offer both, be explicit about what each unlocks:

**Level 1 — Anon key only (low sensitivity):**
User pastes their project URL + anon/public key. You can check:
- Whether RLS is actually enabled on tables reachable via PostgREST (query `information_schema` via the exposed REST API — if a table returns rows with only the anon key, RLS is either off or misconfigured).
- Whether the anon key itself is over-scoped (can it write? call functions it shouldn't?).
- Storage bucket public/private status via the public storage API.
- Auth settings exposed via public endpoints (allowed redirect URLs, whether email confirmation is required, etc. — Supabase exposes some of this without auth).

**Level 2 — Service-role key (deep scan, requires it in the vault):**
User provides the service-role key (or, better, you walk them through creating a **scoped Postgres role** just for you — see below). This unlocks:
- Full RLS policy audit via `pg_policies` — read every policy on every table, flag tables with RLS enabled but no policies (fails closed, but often means "broken," not "secure"), flag overly permissive policies (`USING (true)`).
- Supabase Management API access (if they also grant a Management API token, which is separate from the project's service-role key) — org-level settings, database backups configured, PITR enabled, network restrictions, etc.
- Edge Function source review if they connect the linked GitHub repo (ties back into §4).

**Strongly recommend building a "least privilege connector" instead of asking for the raw service-role key.** Give users a SQL snippet to run once in their Supabase SQL editor that creates a read-only role scoped to what you need:

```sql
create role scanlyfix_readonly noinherit login password '<generated>';
grant usage on schema public to scanlyfix_readonly;
grant select on all tables in schema public to scanlyfix_readonly;
grant select on pg_policies to scanlyfix_readonly; -- for RLS audit
-- explicitly do NOT grant insert/update/delete/execute
```

This is a better trust story than "paste your service-role key into a SaaS," it's easier to get past a security-conscious customer's approval process, and it's strictly less powerful if your vault is ever compromised.

### 5.2 What you scan, concretely

| Check | How |
|---|---|
| RLS enabled per table | `select relname, relrowsecurity from pg_class join pg_namespace ...` |
| RLS enabled but zero policies (fails closed but often a config bug) | Cross-reference `pg_policies` |
| Overly permissive policy (`USING (true)`, no role restriction) | Parse `pg_policies.qual` |
| Anon key can access tables it shouldn't | Attempt a `select` via PostgREST with anon key against each table, compare to expected |
| Storage buckets public when they shouldn't be | Storage API `GET /storage/v1/bucket` |
| Auth redirect URLs too permissive (wildcard) | Management API `GET /v1/projects/{ref}/config/auth` |
| Point-in-time recovery / backups configured | Management API |
| Exposed database version with known CVEs | Management API project info → cross-reference CVE feed |

Add this as a new pillar, or extend "Security," in your findings taxonomy — either works, but keep the evidence-first format you already use ("Observed: policy X on table Y evaluates to `true` for role `anon`") since that's your actual differentiator versus generic scanners.

---

## 6. Terraform / IaC

You don't need a separate "Terraform connector" as a first-class integration — Terraform files almost always live inside the GitHub/GitLab repo you already connected in §4. Treat it as a scan target *within* the repo scan, not a fourth OAuth flow:

- If the repo scan (§4.2) finds `.tf` / `.tf.json` files, run Checkov or Trivy's IaC mode against them.
- Checks: publicly exposed S3/GCS buckets, security groups open to `0.0.0.0/0`, unencrypted storage/RDS, missing logging, IAM policies with wildcard actions/resources, hardcoded secrets in `.tfvars`.
- If you want to go further later, support **Terraform Cloud/Enterprise** as its own connection (API token, `read` scope) to pull the actual *plan/state* rather than just static files — this catches drift between what's declared and what's deployed, which static file scanning can't. This is a v2 feature; static `.tf` scanning via the existing repo connector covers the 80% case with zero new OAuth flow.

---

## 7. Data model additions (Supabase/Postgres)

```sql
-- one row per external connection a user has authorized
create table connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  provider text not null check (provider in ('github','gitlab','supabase','terraform_cloud')),
  external_account text,          -- org login, project ref, etc.
  scopes text[] not null,
  vault_secret_id uuid not null,  -- pointer into the credential vault, not the secret itself
  status text not null default 'active' check (status in ('active','revoked','error')),
  last_scanned_at timestamptz,
  created_at timestamptz default now(),
  revoked_at timestamptz
);

-- extends your existing scan_runs table
alter table scan_runs add column connection_id uuid references connections(id);
alter table scan_runs add column scan_type text default 'url' check (scan_type in ('url','repo','supabase','iac'));

-- audit trail for every credential decrypt, separate from app logs
create table credential_access_log (
  id bigint generated always as identity primary key,
  connection_id uuid references connections(id),
  scan_run_id uuid references scan_runs(id),
  accessed_at timestamptz default now()
);
```

Keep `findings` schema as-is if it already has `pillar`, `severity`, `evidence`, `location`, `fix_prompt` — just add `github`, `gitlab`, `supabase`, `terraform` as new pillar or source-tag values so your existing report/monitoring UI doesn't need a rewrite.

---

## 8. Auto-fix (where this pays off long-term)

Once you have GitHub App access with `Contents: Read-only`, upgrading a specific, opt-in flow to `Contents: Read & write` + `Pull requests: Write` lets you offer what Strix's platform and tools like Snyk/Dependabot already do: **open a PR with the fix** instead of just a copy-paste prompt. Sequence it as its own consent step — a user connecting for scanning shouldn't silently also grant write access. Good v2 milestone once the read-only pipeline is stable and trusted.

---

## 9. Monitoring integration

You already have daily re-scans and score-diffing with engine-version pinning for URL scans — extend the identical model:
- Re-run repo/Supabase/IaC scans on a schedule (daily or on webhook: GitHub push events for the repo connector, since you already have the App installed and can subscribe to `push`).
- Diff findings run-over-run the same way you diff URL scan scores — "new secret committed since yesterday" is a much stronger alert than "monthly re-scan found the same 40 issues."
- Webhook-triggered scans (on push/merge) are your strongest subscription-retention feature: "we caught the leaked key in the PR before it was even merged" is a materially better pitch than "we found the leaked key in main."

---

## 10. Build order (suggested)

1. **Credential vault + connections table + revoke flow.** Ship nothing user-facing until this works end to end, including a real revoke.
2. **GitHub App: secrets (Gitleaks) + dependency scan (OSV-Scanner) only.** Smallest surface, highest perceived value ("we found your leaked API key" sells itself), reuses your fix-prompt engine directly.
3. **IaC scanning (Checkov) as an extension of the repo scan** — no new connector, just a new scanner in the same pipeline, covers Terraform.
4. **Supabase Level 1 (anon-key checks)** — no vault-grade secret needed yet, fast to ship, matches your existing "verified domain" trust bar.
5. **Supabase Level 2 (scoped role / service-role, RLS audit)** — your highest-value, hardest-to-copy feature; take the time to build the least-privilege-role onboarding flow rather than just accepting a pasted service-role key.
6. **GitLab** — same pipeline as GitHub, lower priority unless customers ask.
7. **Webhook-triggered re-scans** — biggest retention lever, do this before auto-fix.
8. **Auto-fix PRs** — v2, separate consent, separate GitHub App permission tier.

---

## 11. What to explicitly *not* copy from Strix

For your context, worth restating: Strix's core mechanism is an LLM agent autonomously deciding what to attack and how, live, against a target. That's overkill and the wrong trust model for a subscription SaaS whose customers are the site owners, not third-party researchers — you want **deterministic, explainable, evidence-first checks** (which is your actual brand, per your own "Safety" and "Evidence" sections), not an autonomous agent making exploitation decisions on your customers' production infrastructure. Take the *idea* of "connect a target, get a deep automated report" — not the autonomous-agent architecture.
