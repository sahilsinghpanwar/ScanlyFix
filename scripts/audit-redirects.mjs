/**
 * Redirect preflight: every place a sign-in or GitHub-connect redirect can be
 * misrouted, checked from where the cause is visible.
 *
 *   pnpm audit:redirects
 *
 * The app's redirect code is origin-aware by design (login form uses
 * window.location.origin, the feed's Connect button uses the request's own
 * host). When a redirect still lands on the wrong origin the cause is almost
 * always one of the two provider dashboards — the Supabase project's Site
 * URL / redirect allowlist, or the GitHub App's Callback URLs — because those
 * are the fallbacks the providers use when they cannot honour the redirect
 * the app asked for. See docs/REDIRECT-CONFIG.md for the full explanation
 * and the exact settings.
 *
 * This script checks what CAN be seen from the repository: the .env values the
 * deployment mirrors, the Supabase authorize hop (which also reveals the
 * GitHub OAuth client id in use), and whether the GitHub App variables exist.
 * For everything that lives only in a dashboard it prints the concrete value
 * to set and where, so the fix is a copy-paste rather than an investigation.
 *
 * Exit code 1 when a hard check fails (safe to wire into CI), 0 otherwise.
 */

import { readFileSync } from 'node:fs'

const ENV_PATH = new URL('../.env', import.meta.url).pathname

let raw = ''
try {
  raw = readFileSync(ENV_PATH, 'utf8')
} catch {
  console.error(`No .env at ${ENV_PATH}. Copy .env.example to .env first.`)
  process.exit(1)
}

const env = Object.fromEntries(
  raw
    .split('\n')
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => [
      line.slice(0, line.indexOf('=')).trim(),
      line
        .slice(line.indexOf('=') + 1)
        .trim()
        .replace(/^["']|["']$/g, ''),
    ]),
)

let failures = 0
let notes = 0

const fail = (message) => {
  failures++
  console.error(`  ✗ ${message}`)
}
const note = (message) => {
  notes++
  console.log(`  ! ${message}`)
}
const ok = (message) => console.log(`  ✓ ${message}`)

const appUrl = (env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
const supabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')
const anonKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''

console.log('\n== App URL and Supabase redirect allowlist ==\n')

if (!appUrl) {
  fail('NEXT_PUBLIC_APP_URL is not set. The login form needs it as its server-render fallback.')
} else if (appUrl.startsWith('http://') && !appUrl.includes('localhost')) {
  fail(`NEXT_PUBLIC_APP_URL is ${appUrl} — production must be https.`)
} else {
  ok(`NEXT_PUBLIC_APP_URL = ${appUrl}`)
}

let allowlist = []
if (!env.SUPABASE_REDIRECT_ALLOWLIST) {
  note('SUPABASE_REDIRECT_ALLOWLIST is not set; the proxy logs a warning at boot.')
} else {
  try {
    const parsed = JSON.parse(env.SUPABASE_REDIRECT_ALLOWLIST)
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) throw new Error('shape')
    allowlist = parsed
    ok(`SUPABASE_REDIRECT_ALLOWLIST has ${parsed.length} entries`)
  } catch {
    fail('SUPABASE_REDIRECT_ALLOWLIST is not a JSON array of strings.')
  }
}

if (appUrl && allowlist.length > 0 && !allowlist.includes(`${appUrl}/auth/callback`)) {
  fail(`${appUrl}/auth/callback is missing from SUPABASE_REDIRECT_ALLOWLIST.`)
}
if (allowlist.length > 0 && !allowlist.some((entry) => entry.includes('localhost'))) {
  note('No localhost entry in the allowlist — local sign-in will be refused by Supabase.')
}

console.log('\n== Supabase project (live probe) ==\n')

if (!supabaseUrl || !anonKey) {
  note('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set locally; skipping the live probe.')
} else {
  const probe = new URL('/auth/v1/authorize', supabaseUrl)
  probe.searchParams.set('provider', 'github')
  probe.searchParams.set('redirect_to', `${appUrl || 'https://scanlyfix.com'}/auth/callback`)
  try {
    const res = await fetch(probe, { headers: { apikey: anonKey }, redirect: 'manual' })
    const hop = res.headers.get('location') ?? ''
    const clientId = new URL(hop).searchParams.get('client_id')
    if (res.status === 302 && hop.startsWith('https://github.com/login/oauth/authorize')) {
      ok('Supabase authorize hop reaches GitHub.')
      ok(`GitHub OAuth client id in use: ${clientId ?? 'unknown'}`)
      note(
        `Its Authorization callback URL must be ${supabaseUrl}/auth/v1/callback ` +
          '(Supabase dashboard → Authentication → Providers → GitHub shows the exact value).',
      )
    } else {
      fail(`Supabase authorize answered ${res.status}; expected a 302 to github.com.`)
    }
  } catch (error) {
    note(`Could not reach ${supabaseUrl} (${error.message}); skipping the live probe.`)
  }
}

console.log('\n== GitHub App (connect flow) ==\n')

const hasSlug = Boolean(env.GITHUB_APP_SLUG)
const hasId = Boolean(env.GITHUB_APP_ID)
const hasKey = Boolean(env.GITHUB_APP_PRIVATE_KEY)
if (hasSlug && hasId && hasKey) {
  ok(`GITHUB_APP_SLUG = ${env.GITHUB_APP_SLUG}`)
  ok('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are set.')
} else {
  note(
    'GITHUB_APP_SLUG / GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not all set locally — ' +
      'fine for site scans; the deployment itself must have them or the Connect button hides.',
  )
}

console.log(
  [
    '',
    '== Dashboard checklist (the causes this script cannot see) ==',
    '',
    'Supabase dashboard → Authentication → URL Configuration:',
    `  Site URL       = ${appUrl || 'https://scanlyfix.com'}  (a localhost Site URL is the`,
    '                  classic "sign-in on prod lands on localhost" cause)',
    `  Redirect URLs  must include ${appUrl || 'https://scanlyfix.com'}/auth/callback`,
    '                  and http://localhost:3000/auth/callback for local development.',
    '',
    'GitHub → Settings → Developer settings → GitHub Apps → your app:',
    `  Callback URLs  must include ${appUrl || 'https://scanlyfix.com'}/api/github/callback`,
    '                  (first) and http://localhost:3000/api/github/callback (for dev).',
    '  UNCHECK "Request user authorization (OAuth) during installation" —',
    '                  it makes GitHub ignore our per-origin redirect_url.',
    `  Webhook URL    = ${appUrl || 'https://scanlyfix.com'}/api/webhooks/github`,
    '',
    'Full explanation: docs/REDIRECT-CONFIG.md',
    '',
  ].join('\n'),
)

if (failures > 0) {
  console.error(`${failures} hard failure(s), ${notes} note(s).`)
  process.exit(1)
}
console.log(`${notes} note(s), no hard failures.`)
