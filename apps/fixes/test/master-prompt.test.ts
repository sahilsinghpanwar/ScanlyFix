import { describe, expect, it } from 'vitest'
import { buildMessages, MASTER_PROMPT, parseFixRequest, type FixFindingInput } from '../src/master-prompt.ts'

const VALID: FixFindingInput = {
  checkId: 'security.csp.missing',
  category: 'security',
  severity: 'high',
  title: 'No Content-Security-Policy',
  description: 'The response carries no CSP header.',
  evidence: { header: 'missing' },
  remediation: 'Set a Content-Security-Policy header.',
  siteUrl: 'https://example.com',
}

describe('parseFixRequest', () => {
  it('accepts a well-formed request and fills the optional fields with null', () => {
    const parsed = parseFixRequest({ finding: { checkId: 'a', category: 'b', severity: 'c', title: 'd' } })
    expect(parsed).toEqual({
      ok: true,
      finding: {
        checkId: 'a',
        category: 'b',
        severity: 'c',
        title: 'd',
        description: null,
        remediation: null,
        siteUrl: null,
        evidence: null,
      },
    })
  })

  it('keeps the evidence object as given', () => {
    const parsed = parseFixRequest({ finding: { ...VALID } })
    expect(parsed.ok && parsed.finding.evidence).toEqual({ header: 'missing' })
  })

  it.each([
    ['a non-object body', 'nope'],
    ['a missing finding', {}],
    ['a null finding', { finding: null }],
  ])('rejects %s', (_label, body) => {
    expect(parseFixRequest(body).ok).toBe(false)
  })

  it.each(['checkId', 'category', 'severity', 'title'])('requires finding.%s to be a non-empty string', (key) => {
    const finding: Record<string, unknown> = { ...VALID }
    delete finding[key]
    expect(parseFixRequest({ finding }).ok).toBe(false)
    expect(parseFixRequest({ finding: { ...finding, [key]: '   ' } }).ok).toBe(false)
  })

  it('rejects an oversized identity field, so a hostile body cannot feed the model a chapter', () => {
    const parsed = parseFixRequest({
      finding: { ...VALID, title: 'x'.repeat(501) },
    })
    expect(parsed.ok).toBe(false)
  })

  it('rejects evidence that is not an object — an array or string would not survive the prompt build', () => {
    expect(parseFixRequest({ finding: { ...VALID, evidence: ['x'] } }).ok).toBe(false)
    expect(parseFixRequest({ finding: { ...VALID, evidence: 'missing' } }).ok).toBe(false)
  })

  it('accepts null optional fields — the engine marks them nullable', () => {
    const parsed = parseFixRequest({
      finding: { ...VALID, description: null, evidence: null, remediation: null, siteUrl: null },
    })
    expect(parsed.ok).toBe(true)
  })
})

describe('buildMessages', () => {
  it('puts the master prompt in the system role, verbatim', () => {
    const messages = buildMessages(VALID)
    expect(messages[0]).toEqual({ role: 'system', content: MASTER_PROMPT })
  })

  it('serialises the finding as the user turn with every field the model may use', () => {
    const messages = buildMessages(VALID)
    expect(messages).toHaveLength(2)
    const user = JSON.parse(messages[1].content) as Record<string, unknown>
    expect(user).toMatchObject({
      siteUrl: 'https://example.com',
      checkId: 'security.csp.missing',
      pillar: 'security',
      severity: 'high',
      title: 'No Content-Security-Policy',
      remediationHint: 'Set a Content-Security-Policy header.',
    })
  })

  it('the master prompt tells the model to output only the prompt', () => {
    // The one rule the feature rests on: the response is pasted straight into
    // an AI editor, so any wrapper text becomes part of someone's work order.
    expect(MASTER_PROMPT).toMatch(/prompt is the entire output/)
  })
})
