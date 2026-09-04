/**
 * Authenticating a machine.
 *
 * The decision tree here is short and every branch is a security boundary, so
 * each one is pinned. Two of them are the reason the file exists at all:
 *
 *   - a request with no Authorization header is 401 EVEN IF it carries a valid
 *     session cookie. That is not an omission; honouring the cookie would make
 *     every /api/v1 route a CSRF target, because a browser attaches cookies to
 *     cross-origin requests it was tricked into making and does not attach
 *     headers. This test is what stops someone "fixing" that later.
 *
 *   - a genuine key on a plan without API access is 403, not 401. The
 *     difference is actionable: 401 means "your credential is wrong, check
 *     it", 403 means "your credential is fine, your plan is not".
 *
 * @scanlyfix/db and entitlements are mocked because what is under test is the
 * branching, not the lookups — both are covered against a real Postgres in
 * packages/db/test/api-keys.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { planFor } from '../lib/plans.ts'
import type { Entitlements } from '../lib/entitlements.ts'

const resolveApiKey = vi.fn<(plaintext: string) => Promise<{ userId: string; keyId: string } | null>>()
const entitlementsFor = vi.fn<() => Promise<Entitlements>>()

vi.mock('@scanlyfix/db', () => ({ resolveApiKey: (k: string) => resolveApiKey(k) }))
vi.mock('../lib/entitlements.ts', () => ({ entitlementsFor: () => entitlementsFor() }))

const { authenticateApiRequest, bearerToken } = await import('../lib/api-auth.ts')

const KEY = `sf_${'a'.repeat(64)}`

function entitlements(planId: 'free' | 'pro'): Entitlements {
  const plan = planFor(planId)
  return {
    plan,
    signedIn: true,
    findingsInFull: plan.fullFindings ? Number.POSITIVE_INFINITY : plan.findingsShownInFull,
    priorities: null,
  }
}

/**
 * An entitlements shape with apiAccess explicitly turned off — used to pin the
 * 403 branch even when the live plans table grants free tier API access, as it
 * does in testing mode.
 */
function noApiEntitlements(): Entitlements {
  const base = entitlements('free')
  return { ...base, plan: { ...base.plan, apiAccess: false } }
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://scanlyfix.test/api/v1/scan', { headers })
}

beforeEach(() => {
  resolveApiKey.mockReset()
  entitlementsFor.mockReset()
  resolveApiKey.mockResolvedValue({ userId: 'user-1', keyId: 'key-1' })
  entitlementsFor.mockResolvedValue(entitlements('pro'))
})

describe('bearerToken', () => {
  it('reads the token out of a well-formed header', () => {
    expect(bearerToken(new Headers({ authorization: `Bearer ${KEY}` }))).toBe(KEY)
  })

  it('accepts any casing of the scheme', () => {
    // RFC 6750 says the scheme is case-insensitive, and an HTTP client that
    // title-cases it differently should not get a 401 with no clue why.
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      expect(bearerToken(new Headers({ authorization: `${scheme} ${KEY}` }))).toBe(KEY)
    }
  })

  it('tolerates surrounding and internal whitespace', () => {
    expect(bearerToken(new Headers({ authorization: `  Bearer   ${KEY}  ` }))).toBe(KEY)
  })

  it('returns null for anything that is not a bearer header', () => {
    expect(bearerToken(new Headers())).toBeNull()
    expect(bearerToken(new Headers({ authorization: '' }))).toBeNull()
    expect(bearerToken(new Headers({ authorization: KEY }))).toBeNull() // no scheme
    expect(bearerToken(new Headers({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull()
    expect(bearerToken(new Headers({ authorization: 'Bearer' }))).toBeNull() // no token
    expect(bearerToken(new Headers({ authorization: 'Bearer  ' }))).toBeNull()
    expect(bearerToken(new Headers({ authorization: `Bearer ${KEY} extra` }))).toBeNull()
  })
})

describe('authenticateApiRequest', () => {
  it('accepts a live key on a plan with API access', async () => {
    const auth = await authenticateApiRequest(request({ authorization: `Bearer ${KEY}` }))

    expect(auth.ok).toBe(true)
    if (!auth.ok) return
    expect(auth.principal.viewer).toEqual({ kind: 'user', userId: 'user-1' })
    expect(auth.principal.keyId).toBe('key-1')
    expect(auth.principal.plan.id).toBe('pro')
  })

  it('401s a request with no header, and never reaches the database', async () => {
    const auth = await authenticateApiRequest(request())

    expect(auth).toMatchObject({ ok: false, status: 401 })
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('401s a session cookie with no Authorization header', async () => {
    /*
     * The CSRF boundary. A browser tricked into POSTing from another origin
     * sends this cookie and cannot send the header — so the cookie must buy
     * nothing here. If this test ever fails because someone added a session
     * fallback, that is the bug, not the test.
     */
    const auth = await authenticateApiRequest(
      request({ cookie: 'sb-access-token=a-perfectly-valid-session' }),
    )

    expect(auth).toMatchObject({ ok: false, status: 401 })
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('401s an unknown or revoked key', async () => {
    resolveApiKey.mockResolvedValue(null)

    const auth = await authenticateApiRequest(request({ authorization: `Bearer ${KEY}` }))
    expect(auth).toMatchObject({ ok: false, status: 401 })
  })

  it('gives the same message for malformed, unknown and revoked keys', async () => {
    resolveApiKey.mockResolvedValue(null)

    const bad = await authenticateApiRequest(request({ authorization: 'Bearer not-a-key' }))
    const unknown = await authenticateApiRequest(request({ authorization: `Bearer ${KEY}` }))

    // Distinguishing them tells someone probing keys which guesses were
    // closer, and tells a legitimate caller nothing they can act on.
    if (bad.ok || unknown.ok) throw new Error('expected both to fail')
    expect(bad.error).toBe(unknown.error)
  })

  it('403s a genuine key whose plan does not include API access', async () => {
    entitlementsFor.mockResolvedValue(noApiEntitlements())

    const auth = await authenticateApiRequest(request({ authorization: `Bearer ${KEY}` }))

    expect(auth).toMatchObject({ ok: false, status: 403 })
    if (auth.ok) return
    expect(auth.error).toContain('Free')
  })

  it('re-checks the plan on every request, not just at key creation', async () => {
    // A subscription can lapse after a key is minted. The key must not outlive
    // the entitlement that justified it.
    const header = { authorization: `Bearer ${KEY}` }
    expect((await authenticateApiRequest(request(header))).ok).toBe(true)

    entitlementsFor.mockResolvedValue(noApiEntitlements())
    expect((await authenticateApiRequest(request(header))).ok).toBe(false)
  })
})
