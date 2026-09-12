/**
 * Connecting and Level-1 scanning a Supabase project.
 *
 * Level 1 means: the user pastes their project URL and the PUBLISHABLE (anon)
 * key — the pair their own frontend ships to every visitor — and we run only
 * the checks that pair legitimately allows. No service-role key is accepted,
 * ever: the validator refuses one by name, because "paste your service-role
 * key" is the trust mistake this tier exists to avoid (see the deep-scan
 * integration plan §5; Level 2's scoped-Postgres-role flow is a later build).
 *
 * What a publishable key legitimately lets us see, and therefore what we check:
 *   - GET /auth/v1/settings   — the project's public auth configuration.
 *   - GET /rest/v1/           — the PostgREST OpenAPI schema: which tables exist.
 *   - GET /rest/v1/{table}?limit=1 per table — whether the anon role can READ
 *     rows. A 200 here is the highest-value finding in this tier: RLS is off
 *     or its policy lets `anon` through, and every visitor's browser could
 *     pull the data the same way we just did.
 *
 * Evidence-first, per the product's own standard: a finding states what was
 * OBSERVED (the request that succeeded), not what might be wrong somewhere.
 *
 * This module is deliberately dependency-free (no server-only, no env) so the
 * validators and the scan mapping are unit-testable; the routes that call it
 * own authentication, viewer checks and secret handling.
 */

/** The engine version stamped on every stored scan result. Bump when a check's meaning changes. */
export const SUPABASE_L1_ENGINE_VERSION = 'supabase-l1-v1'

/** Tables probed per scan. A project with more tables than this scans the rest as unknown — bounded work beats unbounded exposure. */
export const MAX_TABLES_PROBED = 40

const UA = 'scanlyfix-connections'

export type ParseResult =
  | { ok: true; ref: string; projectUrl: string }
  | { ok: false; reason: string }

/**
 * Accept what a person realistically pastes: the bare project URL, the REST
 * or auth subpath of one, or the whole thing with a trailing slash. Extracts
 * the project ref and normalises to the bare origin. Only real Supabase
 * project hosts are accepted — the anon key we are about to store must not be
 * sent anywhere else.
 */
export function parseProjectUrl(input: string): ParseResult {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return { ok: false, reason: 'Enter your Supabase project URL.' }

  const candidate = /^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, reason: `"${trimmed}" is not a valid URL.` }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Supabase project URLs are always https:// — use the one from your project settings.' }
  }

  // *.supabase.co is the project host. A custom domain cannot carry the ref,
  // and the ref is what scopes the stored grant, so hosts without one are refused.
  if (!url.hostname.endsWith('.supabase.co')) {
    return { ok: false, reason: 'That does not look like a Supabase project URL — it should end in .supabase.co.' }
  }

  const ref = url.hostname.slice(0, -'.supabase.co'.length).split('.')[0]
  if (!ref || !/^[a-z0-9]+$/i.test(ref)) {
    return { ok: false, reason: 'Could not read the project ref from that URL.' }
  }

  return { ok: true, ref, projectUrl: url.origin }
}

export type KeyCheck =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * The publishable-key gate. Supabase ships two generations:
 *   - legacy JWT keys, whose payload carries a `role` claim ('anon' | 'service_role' | …)
 *   - the newer `sb_publishable_…` / `sb_secret_…` API keys
 * Only the publishable two are accepted. A service_role or sb_secret key is
 * refused BY NAME — a generic "invalid key" here would send someone straight
 * to the legacy docs to find a key we would rather not hold.
 */
export function validateAnonKey(key: string): KeyCheck {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, reason: 'Enter your publishable (anon) key.' }

  if (trimmed.startsWith('sb_publishable_')) return { ok: true }

  if (trimmed.startsWith('sb_secret_')) {
    return { ok: false, reason: 'That is a SECRET key. This connection only takes the publishable (anon) key — never paste the secret one.' }
  }

  const [head, payload, signature] = trimmed.split('.')
  if (head !== undefined && head.startsWith('eyJ') && payload !== undefined && signature !== undefined) {
    let role: string | undefined
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: string }
      role = parsed.role
    } catch {
      return { ok: false, reason: 'That key could not be read. Copy it again from your Supabase project settings.' }
    }
    if (role === 'service_role') {
      return { ok: false, reason: 'That is your service_role key — it bypasses row-level security entirely. This connection only takes the publishable (anon) key.' }
    }
    if (role === 'anon') return { ok: true }
    return { ok: false, reason: `That key's role is "${role ?? 'unknown'}" — this connection only takes the publishable (anon) key.` }
  }

  return { ok: false, reason: 'That does not look like a publishable (anon) key. Copy the "anon public" one from Project Settings → API keys.' }
}

function authHeaders(key: string): HeadersInit {
  return { apikey: key, Authorization: `Bearer ${key}`, 'User-Agent': UA }
}

export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Reachability check before anything is stored: the URL must answer and the
 * key must be accepted. Without it, a typo would sit in the database as an
 * "active" connection and only surface as a scan failure later.
 */
export async function probeProject(projectUrl: string, key: string): Promise<ProbeResult> {
  let res: Response
  try {
    res = await fetch(`${projectUrl}/auth/v1/settings`, { headers: authHeaders(key), redirect: 'manual' })
  } catch {
    return { ok: false, reason: 'Could not reach that project URL. Check it and that the project is not paused.' }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'The project answered but rejected that key. Copy the publishable (anon) key from Project Settings → API keys.' }
  }
  if (!res.ok) {
    return { ok: false, reason: `The project answered with ${res.status}. Is the URL the project's own (${projectUrl})?` }
  }
  return { ok: true }
}

export interface SupabaseCheckFinding {
  checkId: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description: string
  evidence: Record<string, unknown> | null
  remediation: string
}

export interface SupabaseCheckError {
  checkId: string
  message: string
}

export interface SupabaseScanOutput {
  checkedAt: string
  engineVersion: string
  checksRun: number
  findings: SupabaseCheckFinding[]
  errors: SupabaseCheckError[]
}

/**
 * Table names from the PostgREST OpenAPI document. `definitions` is the
 * OpenAPI-2 field PostgREST has emitted for years; newer versions answering
 * OpenAPI-3 use `components.schemas`. Either way the keys are the exposed
 * tables and views.
 */
function tablesFromOpenApi(doc: Record<string, unknown>): string[] {
  const definitions =
    (doc['definitions'] as Record<string, unknown> | undefined) ??
    ((doc['components'] as Record<string, unknown> | undefined)?.['schemas'] as
      | Record<string, unknown>
      | undefined)
  return definitions ? Object.keys(definitions).sort() : []
}

/**
 * One Level-1 pass. Every network failure becomes an `errors` entry, never a
 * throw — a scan that half-ran still records what it did see.
 */
export async function scanSupabaseLevel1(
  projectUrl: string,
  key: string,
): Promise<SupabaseScanOutput> {
  const findings: SupabaseCheckFinding[] = []
  const errors: SupabaseCheckError[] = []
  let checksRun = 0
  let tables: string[] = []

  // ── 1. Public auth configuration ────────────────────────────────────────
  let authSettings: Record<string, unknown> | null = null
  try {
    const res = await fetch(`${projectUrl}/auth/v1/settings`, { headers: authHeaders(key) })
    checksRun++
    if (res.ok) {
      authSettings = (await res.json()) as Record<string, unknown>
    } else {
      errors.push({ checkId: 'auth-settings', message: `auth/v1/settings answered ${res.status}` })
    }
  } catch (cause) {
    errors.push({ checkId: 'auth-settings', message: String(cause) })
  }

  if (authSettings?.['mailer_autoconfirm'] === true) {
    findings.push({
      checkId: 'auth-autoconfirm',
      severity: 'low',
      title: 'Email confirmation is disabled',
      description:
        'Observed: auth/v1/settings reports mailer_autoconfirm = true. Any address can register and hold a session without proving it controls the mailbox.',
      evidence: { setting: 'mailer_autoconfirm', value: true },
      remediation:
        'In Supabase → Authentication → Providers → Email, turn ON "Confirm email" so unverified addresses never receive a session.',
    })
  }

  // ── 2. REST schema exposure + per-table anon readability ───────────────
  try {
    const res = await fetch(`${projectUrl}/rest/v1/`, { headers: authHeaders(key) })
    checksRun++
    if (res.ok) {
      const doc = (await res.json()) as Record<string, unknown>
      tables = tablesFromOpenApi(doc)
    } else if (res.status === 404) {
      // PostgREST returns 404 for the spec root only when the anon key cannot
      // read the schema at all — that is the GOOD outcome for this check.
    } else {
      errors.push({ checkId: 'rest-openapi', message: `rest/v1/ answered ${res.status}` })
    }
  } catch (cause) {
    errors.push({ checkId: 'rest-openapi', message: String(cause) })
  }

  if (tables.length > 0) {
    findings.push({
      checkId: 'rest-schema-exposed',
      severity: 'info',
      title: `REST schema exposes ${tables.length} table${tables.length === 1 ? '' : 's'}`,
      description:
        'Observed: the PostgREST OpenAPI document, fetchable by anyone holding the publishable key (your frontend ships it to every visitor), lists these tables/views. Table names are not a secret by themselves, but anything in this list you expected to be private is reachable design, not an accident to fix.',
      evidence: { tables: tables.slice(0, MAX_TABLES_PROBED) },
      remediation:
        'If a table should not be public-facing, revoke its grants from `anon` (Supabase → Database → Tables, or a revoke statement in the SQL editor).',
    })
  }

  for (const table of tables.slice(0, MAX_TABLES_PROBED)) {
    try {
      const res = await fetch(`${projectUrl}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
        headers: authHeaders(key),
      })
      checksRun++
      if (res.status === 200) {
        const rows = (await res.json()) as unknown[]
        findings.push({
          checkId: 'anon-readable-table',
          severity: 'critical',
          title: `Table "${table}" is readable by the public anon key`,
          description: `Observed: GET /rest/v1/${table} returned ${rows.length} row${rows.length === 1 ? '' : 's'} to the publishable key — the same request any visitor's browser can make. Row-level security is off for this table or its policy allows the anon role to read.`,
          evidence: { table, status: 200, rowsReturned: rows.length },
          remediation:
            `Enable RLS on "${table}" (Supabase → Database → Tables → RLS) and add explicit policies for the roles that genuinely need read access. If the table must serve anon reads, scope the policy to the columns and rows that are meant to be public.`,
        })
      }
      // 401/403/404: the anon role is denied — no finding. Anything else is noise.
    } catch (cause) {
      errors.push({ checkId: 'anon-readable-table', message: `${table}: ${String(cause)}` })
    }
  }

  if (tables.length > MAX_TABLES_PROBED) {
    errors.push({
      checkId: 'anon-readable-table',
      message: `Project exposes ${tables.length} tables; probed the first ${MAX_TABLES_PROBED}.`,
    })
  }

  return {
    checkedAt: new Date().toISOString(),
    engineVersion: SUPABASE_L1_ENGINE_VERSION,
    checksRun,
    findings,
    errors,
  }
}
