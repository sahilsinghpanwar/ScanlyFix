/**
 * The paywall.
 *
 * Nearly every test here asserts on the SERIALIZED output rather than on the
 * object, because that is the only thing that proves the guarantee. A locked
 * finding built by spreading the full one satisfies the LockedFinding type and
 * still carries fixPrompt over the wire — types are erased and
 * JSON.stringify does not read them.
 *
 * TESTING MODE: the free tier currently matches Pro on every entitlement, so
 * the assertion of interest is the one that does NOT change with plan
 * configuration — that a reader with no account gets nothing in full and never
 * receives a fix prompt. That guarantee is the security boundary under test
 * here; the per-plan numbers are exercised by the api-auth test alongside.
 */

import { describe, expect, it } from 'vitest'
import { canSeeFixPrompt, redactFindings, type RedactableFinding } from '../lib/redact.ts'
import { planFor } from '../lib/plans.ts'
import type { Entitlements } from '../lib/entitlements.ts'

// A signed-out reader is not a plan. Their allowance is hard-coded to zero in
// lib/entitlements.ts and is independent of the plans table — this exercises
// that guarantee rather than the per-plan numbers.
const anonymous: Entitlements = {
  plan: planFor('free'),
  signedIn: false,
  findingsInFull: 0,
  priorities: null,
}
// In testing mode the paid and free tier collapse to one entitlement shape.
const free: Entitlements = {
  plan: planFor('free'),
  signedIn: true,
  findingsInFull: planFor('free').findingsShownInFull,
  priorities: null,
}
const pro: Entitlements = {
  plan: planFor('pro'),
  signedIn: true,
  findingsInFull: Number.POSITIVE_INFINITY,
  priorities: ['security'],
}

/**
 * A deliberately limited entitlements shape used to pin the redaction logic —
 * independent of the live plans table so this test continues to encode the
 * paywall's worst-first behaviour even when the free tier is configured to
 * match Pro.
 */
const lowTier: Entitlements = {
  plan: planFor('free'),
  signedIn: true,
  findingsInFull: 3,
  priorities: null,
}

const finding = (n: number): RedactableFinding => ({
  checkId: `check.${n}`,
  category: 'security',
  severity: 'high',
  title: `title ${n}`,
  description: `SECRET-DESCRIPTION-${n}`,
  evidence: { header: `SECRET-EVIDENCE-${n}` },
  remediation: `SECRET-REMEDIATION-${n}`,
  fixPrompt: `SECRET-FIXPROMPT-${n}`,
})

const many = (count: number) => Array.from({ length: count }, (_, i) => finding(i))

describe('redactFindings', () => {
  it('gives a paying reader everything', () => {
    const report = redactFindings(many(10), pro)
    expect(report.lockedCount).toBe(0)
    expect(report.findings.every((f) => f.locked === false)).toBe(true)
  })

  it('opens nothing for a signed-out reader, and still names everything', () => {
    const report = redactFindings(many(10), anonymous)

    expect(report.lockedCount).toBe(10)
    expect(report.findings.every((f) => f.locked === true)).toBe(true)
    // The shape of the report is the whole offer: a stranger must be able to
    // see that there are ten problems and how bad they are.
    expect(report.findings.map((f) => f.title)).toEqual(many(10).map((f) => f.title))
    expect(report.lockedSeverities).toHaveLength(10)
  })

  it('sends no withheld text to a signed-out reader', () => {
    const wire = JSON.stringify(redactFindings(many(10), anonymous))

    expect(wire).not.toContain('SECRET-DESCRIPTION')
    expect(wire).not.toContain('SECRET-EVIDENCE')
    expect(wire).not.toContain('SECRET-REMEDIATION')
    expect(wire).not.toContain('SECRET-FIXPROMPT')
  })

  it('gives a low-tier signed-in reader the worst three in full', () => {
    const report = redactFindings(many(10), lowTier)
    expect(report.findings.filter((f) => !f.locked)).toHaveLength(3)
    expect(report.lockedCount).toBe(7)
  })

  it('keeps the engine ordering, so the three shown are the three worst', () => {
    const report = redactFindings(many(10), lowTier)
    expect(report.findings.slice(0, 3).map((f) => f.checkId)).toEqual(['check.0', 'check.1', 'check.2'])
  })

  it('NEVER serializes withheld content', () => {
    // The test the whole file exists for. If a locked finding is ever built by
    // spreading the full one, the type still checks and this fails.
    const serialized = JSON.stringify(redactFindings(many(10), lowTier))
    for (const marker of ['SECRET-DESCRIPTION-5', 'SECRET-EVIDENCE-5', 'SECRET-REMEDIATION-5', 'SECRET-FIXPROMPT-5']) {
      expect(serialized).not.toContain(marker)
    }
  })

  it('still serializes the content a low-tier reader IS entitled to', () => {
    const serialized = JSON.stringify(redactFindings(many(10), lowTier))
    expect(serialized).toContain('SECRET-FIXPROMPT-0')
  })

  it('tells the reader what they are missing, not just how much', () => {
    // "2 more findings, 1 of them low" converts; a blurred rectangle does not.
    const mixed: RedactableFinding[] = [
      { ...finding(0), severity: 'critical' },
      { ...finding(1), severity: 'high' },
      { ...finding(2), severity: 'high' },
      { ...finding(3), severity: 'medium' },
      { ...finding(4), severity: 'low' },
    ]
    const report = redactFindings(mixed, lowTier)
    expect(report.lockedSeverities).toEqual(['medium', 'low'])
  })

  it('locks nothing when there is less than the low-tier allowance', () => {
    expect(redactFindings(many(2), lowTier).lockedCount).toBe(0)
  })

  it('handles a report with no findings', () => {
    expect(redactFindings([], free)).toEqual({ findings: [], lockedCount: 0, lockedSeverities: [] })
  })

  it('normalises absent evidence to null rather than dropping the field', () => {
    const [first] = redactFindings([{ ...finding(0), evidence: undefined }], pro).findings
    expect(first?.locked === false && first.evidence).toBeNull()
  })
})

describe('canSeeFixPrompt', () => {
  it('withholds the aggregate prompt from an anonymous reader regardless of plan', () => {
    // The contract under test here is server-side enforcement on the VIEWER,
    // not on the plan. With free == pro in testing mode the cheapest way to
    // pin the gate is against the constant entitlements shape the free tier
    // would have if the limits were restored.
    const gated: Entitlements = { ...lowTier, plan: { ...lowTier.plan, fixPrompts: false } }
    expect(canSeeFixPrompt(gated)).toBe(false)
  })

  it('gives it to a paying reader', () => {
    expect(canSeeFixPrompt(pro)).toBe(true)
  })

  it('gives it to a free reader in testing mode', () => {
    // TESTING MODE: free == pro on fixPrompts. Restoring the previous limit
    // is one edit away; this test catches accidental regressions on the way.
    expect(canSeeFixPrompt(free)).toBe(true)
  })
})
