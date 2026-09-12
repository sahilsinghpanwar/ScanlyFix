import { describe, expect, it } from 'vitest'
import { parseProjectUrl, validateAnonKey } from '@/lib/supabase-connect.ts'

/** Builds a real JWT-shaped key with the given role claim, like Supabase's legacy keys. */
function jwtKey(role: string): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase', ref: 'testref' })}.sig`
}

describe('parseProjectUrl', () => {
  it('accepts a bare project URL and extracts the ref', () => {
    const parsed = parseProjectUrl('https://mxjrcpkfechlylaiaape.supabase.co')
    expect(parsed).toEqual({
      ok: true,
      ref: 'mxjrcpkfechlylaiaape',
      projectUrl: 'https://mxjrcpkfechlylaiaape.supabase.co',
    })
  })

  it('normalises a pasted REST URL down to the project origin', () => {
    const parsed = parseProjectUrl('https://myref.supabase.co/rest/v1/profiles?select=*')
    expect(parsed).toEqual({ ok: true, ref: 'myref', projectUrl: 'https://myref.supabase.co' })
  })

  it('prepends https:// for a scheme-less paste and trims trailing slashes', () => {
    const parsed = parseProjectUrl('myref.supabase.co/')
    expect(parsed).toEqual({ ok: true, ref: 'myref', projectUrl: 'https://myref.supabase.co' })
  })

  it('rejects plain http', () => {
    expect(parseProjectUrl('http://myref.supabase.co').ok).toBe(false)
  })

  it('rejects hosts that are not Supabase projects', () => {
    expect(parseProjectUrl('https://evil.example.com').ok).toBe(false)
    expect(parseProjectUrl('https://supabase.co.evil.example').ok).toBe(false)
  })

  it('rejects empty input', () => {
    expect(parseProjectUrl('   ').ok).toBe(false)
  })
})

describe('validateAnonKey', () => {
  it('accepts the new sb_publishable_ key format', () => {
    expect(validateAnonKey('sb_publishable_abc123')).toEqual({ ok: true })
  })

  it('accepts a legacy JWT anon key', () => {
    expect(validateAnonKey(jwtKey('anon'))).toEqual({ ok: true })
  })

  it('refuses a legacy service_role key BY NAME', () => {
    const check = validateAnonKey(jwtKey('service_role'))
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('service_role')
  })

  it('refuses the new sb_secret_ key format BY NAME', () => {
    const check = validateAnonKey('sb_secret_abc123')
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('SECRET')
  })

  it('refuses a JWT with an unexpected role', () => {
    expect(validateAnonKey(jwtKey('authenticated')).ok).toBe(false)
  })

  it('refuses an empty key and random text', () => {
    expect(validateAnonKey('   ').ok).toBe(false)
    expect(validateAnonKey('hello world').ok).toBe(false)
  })
})
