/**
 * Environment access, in one place, validated once.
 *
 * Two things this buys. A missing variable fails at boot with a sentence
 * naming it, instead of surfacing as `undefined` inside a database driver at
 * 2am. And server-only secrets stay importable only from server code: a client
 * component that reaches for `serverEnv` fails the build, which is a cheaper
 * way to keep a secret out of a JS bundle than remembering not to.
 *
 * Hand-written rather than schema-validated: fifteen lines with no dependency
 * read better than a library for a handful of strings.
 */

import 'server-only'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        "Set it in your deployment's environment (or copy .env.example to .env " +
        'at the repository root when running locally).',
    )
  }
  return value
}

export const serverEnv = {
  /** Postgres. The one variable this phase actually needs. */
  get databaseUrl() {
    return required('DATABASE_URL')
  },

  /**
   * Supabase Auth. The publishable key is also NEXT_PUBLIC_ — same value, read
   * here for server code that wants a typed access path rather than a raw
   * process.env lookup.
   */
  get supabaseUrl() {
    return process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  },
  get supabaseAnonKey() {
    return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''
  },

  /**
   * Salt for hashing visitor addresses before they reach the database. Without
   * one, a hash of an IPv4 address is trivially reversed — there are only four
   * billion of them, which is minutes of brute force.
   */
  get ipHashSalt() {
    return required('IP_HASH_SALT')
  },

  /** Razorpay. Absent until billing is configured; the routes say so cleanly. */
  get razorpayKeyId() {
    return required('RAZORPAY_KEY_ID')
  },
  get razorpayKeySecret() {
    return required('RAZORPAY_KEY_SECRET')
  },
  /** The Plan created in the Razorpay dashboard. Its amount is the real price. */
  get razorpayProPlanId() {
    return required('RAZORPAY_PLAN_PRO_MONTHLY')
  },
  /**
   * A DIFFERENT secret from the API one: Razorpay generates it per webhook in
   * the dashboard. Signing a webhook check with the API secret is the second
   * commonest way this integration fails.
   */
  get razorpayWebhookSecret() {
    return required('RAZORPAY_WEBHOOK_SECRET')
  },
  get appUrl() {
    // Required: a silent fallback to localhost in production was the exact bug
    // that made OAuth sign-in appear to work locally and silently fail in
    // production. The matching "Site URL" lives in the Supabase Auth → URL
    // Configuration dashboard, and `${appUrl}/auth/callback` must be on its
    // redirect allowlist — see SUPABASE_REDIRECT_ALLOWLIST below.
    return required('NEXT_PUBLIC_APP_URL')
  },

  /**
   * Redirect URIs this deployment will accept. Mirrors the Supabase dashboard's
   * allowlist so a misconfiguration surfaces as a single boot-time log line
   * instead of a silent sign-in failure. Not a security boundary — Supabase
   * already refuses to redirect to anything not in its own allowlist.
   */
  get redirectAllowlist(): readonly string[] {
    const raw = process.env.SUPABASE_REDIRECT_ALLOWLIST
    if (!raw) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        'SUPABASE_REDIRECT_ALLOWLIST is not valid JSON. ' +
          'Expected something like: ["https://example.com/auth/callback"]',
      )
    }
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
      throw new Error('SUPABASE_REDIRECT_ALLOWLIST must be a JSON array of strings.')
    }
    return parsed as readonly string[]
  },
  /**
   * True when a subscription can actually be created, so a route can refuse
   * cleanly instead of throwing. The webhook secret is deliberately NOT part
   * of this: checkout works without it, and a deployment that takes money
   * while silently dropping webhooks is a worse failure than one that cannot
   * take money at all — so the webhook route checks for it separately and
   * complains loudly.
   */
  get billingConfigured() {
    return Boolean(
      process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_PLAN_PRO_MONTHLY,
    )
  },
  get webhookConfigured() {
    return Boolean(process.env.RAZORPAY_WEBHOOK_SECRET)
  },

  /**
   * Repo-scanner worker (GitHub repo scans). Both variables are required
   * together; the token is a shared secret you choose and the worker refuses to
   * start without it. Gated exactly like billing: a deployment with no repo
   * scanner still runs site scans, and repo scans fall back to the stub worker
   * until this is configured — see lib/repo-scanner.ts. Deliberately NOT part
   * of assertServerEnv, so an un-provisioned deploy boots and scans sites.
   */
  get repoScannerUrl() {
    return process.env.SCANLYFIX_REPO_SCANNER_URL ?? ''
  },
  get repoScannerToken() {
    return process.env.SCANLYFIX_REPO_SCANNER_TOKEN ?? ''
  },
  get repoScannerConfigured() {
    return Boolean(process.env.SCANLYFIX_REPO_SCANNER_URL && process.env.SCANLYFIX_REPO_SCANNER_TOKEN)
  },

  /**
   * Fix tier (apps/fixes). Turns one finding into the prompt that fixes it,
   * written by a model. Gated exactly like the repo scanner: a deployment
   * with no fix tier still works everywhere else, and the Fix button explains
   * itself rather than throwing — see lib/fixes.ts.
   */
  get fixesUrl() {
    return process.env.SCANLYFIX_FIXES_URL ?? ''
  },
  get fixesToken() {
    return process.env.SCANLYFIX_FIXES_TOKEN ?? ''
  },
  get fixesConfigured() {
    return Boolean(process.env.SCANLYFIX_FIXES_URL && process.env.SCANLYFIX_FIXES_TOKEN)
  },

  /**
   * GitHub App slug for the installation redirect. The full URL is
   * `https://github.com/apps/{slug}/installations/new`. When absent, the
   * Connect GitHub button on the feed page hides itself.
   */
  get githubAppSlug() {
    return process.env.GITHUB_APP_SLUG ?? ''
  },
  /**
   * Numeric id of the registered ScanlyFix GitHub App. Used to sign the JWT
   * that exchanges for a short-lived installation access token.
   */
  get githubAppId() {
    return process.env.GITHUB_APP_ID ?? ''
  },
  /**
   * PEM private key for the GitHub App. Stored PEM-encoded with newlines as
   * literal `\n` in the environment (a common convention); we unescape when
   * handing it to the JWT signer.
   */
  get githubAppPrivateKey() {
    return process.env.GITHUB_APP_PRIVATE_KEY ?? ''
  },
  /**
   * Webhook secret used to verify `X-Hub-Signature-256` on
   * `/api/webhooks/github`. Set on the GitHub App page; without it we cannot
   * tell a real GitHub event from a forged one.
   */
  get githubWebhookSecret() {
    return process.env.GITHUB_WEBHOOK_SECRET ?? ''
  },
  /**
   * OAuth client secret for the GitHub App. Used when the App has its own
   * user-flow callback (the redirect we receive after install). Empty when
   * the App is configured webhook-only.
   */
  get githubClientSecret() {
    return process.env.GITHUB_APP_CLIENT_SECRET ?? ''
  },
  /**
   * The public origin the request reached us on — the absolute URL the
   * GitHub App should bounce back to after install. Falls back to
   * NEXT_PUBLIC_SITE_URL (the production origin) so a deploy doesn't need to
   * inject an extra variable just for the redirect.
   */
  get siteOrigin() {
    return process.env.NEXT_PUBLIC_SITE_URL ?? ''
  },
  get githubConfigured() {
    return Boolean(
      process.env.GITHUB_APP_SLUG &&
        process.env.GITHUB_APP_ID &&
        process.env.GITHUB_APP_PRIVATE_KEY,
    )
  },
  get githubWebhookConfigured() {
    return Boolean(process.env.GITHUB_APP_SLUG && process.env.GITHUB_WEBHOOK_SECRET)
  },

  /**
   * Alert email. Absent means monitoring records alerts that reach nobody, so
   * the transport logs loudly rather than failing quietly — see lib/email.ts.
   * Deliberately not part of assertServerEnv: a deployment with no mail
   * provider should still scan, and a monitoring feature nobody has enabled
   * yet is not a reason to refuse every request.
   */
  get alertsConfigured() {
    return Boolean(process.env.RESEND_API_KEY)
  },

  get isProduction() {
    return process.env.NODE_ENV === 'production'
  },
} as const

/**
 * Read at startup so a misconfigured deploy fails immediately rather than on
 * the first visitor. Called from the scan route, which is the first thing any
 * request touches.
 */
export function assertServerEnv(): void {
  void serverEnv.databaseUrl
  void serverEnv.ipHashSalt
  void serverEnv.appUrl
  void serverEnv.redirectAllowlist
}
