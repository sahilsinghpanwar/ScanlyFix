import { describe, expect, it } from 'vitest'
import { fixFailure } from '@/lib/fixes.ts'

describe('fixFailure', () => {
  it('marks the transient reasons retryable — a second press can genuinely succeed', () => {
    for (const reason of ['busy', 'upstream', 'network'] as const) {
      const failure = fixFailure(reason)
      expect(failure.body.retryable, reason).toBe(true)
      expect(failure.status, reason).toBe(502)
    }
  })

  it('never marks an unconfigured deployment retryable — no retry reaches the env', () => {
    const failure = fixFailure('unconfigured')
    expect(failure.status).toBe(503)
    expect(failure.body.retryable).toBe(false)
    expect(failure.body.error).toMatch(/SCANLYFIX_FIXES_URL/)
  })

  it('every reason carries a sentence a person can act on', () => {
    for (const reason of ['unconfigured', 'busy', 'upstream', 'network'] as const) {
      const failure = fixFailure(reason)
      expect(failure.body.error.length).toBeGreaterThan(10)
    }
  })
})
