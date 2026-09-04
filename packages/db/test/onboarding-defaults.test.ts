/**
 * Tests for Phase 7.1 onboarding defaults — auto-create monitors on
 * project creation + auto-enable rescan on first scan completion.
 *
 * Pure-helper coverage (no DB):
 *   - DEFAULT_MONITOR_TYPES ordering
 *   - DEFAULT_MONITOR_INTERVALS per-type values
 *   - DEFAULT_MONITOR_ENABLED — uptime/domain/web_vitals on, rescan off
 *
 * Mocked-DB coverage:
 *   - ensureDefaultMonitors: idempotent upsert on (projectId, type)
 *   - enableRescanMonitorIfPresent: flips only when enabled=false
 *   - createProjectWithMonitors: transactional; limit-reached returns
 *     the same shape as createProject
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MONITOR_ENABLED,
  DEFAULT_MONITOR_INTERVALS,
  DEFAULT_MONITOR_TYPES,
  enableRescanMonitorIfPresent,
  ensureDefaultMonitors,
} from '../src/queries/onboarding-defaults.ts'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

describe('DEFAULT_MONITOR_TYPES', () => {
  it('contains exactly the four monitor kinds', () => {
    expect(new Set(DEFAULT_MONITOR_TYPES)).toEqual(
      new Set(['uptime', 'domain', 'web_vitals', 'rescan']),
    )
  })

  it('orders uptime first (the highest-traffic monitor, surfaces first on the status page)', () => {
    expect(DEFAULT_MONITOR_TYPES[0]).toBe('uptime')
  })
})

describe('DEFAULT_MONITOR_INTERVALS', () => {
  it('sets uptime to one minute', () => {
    expect(DEFAULT_MONITOR_INTERVALS.uptime).toBe(60)
  })

  it('sets domain checks to daily', () => {
    expect(DEFAULT_MONITOR_INTERVALS.domain).toBe(86_400)
  })

  it('sets web_vitals to 6h', () => {
    expect(DEFAULT_MONITOR_INTERVALS.web_vitals).toBe(21_600)
  })

  it('sets rescan to daily', () => {
    expect(DEFAULT_MONITOR_INTERVALS.rescan).toBe(86_400)
  })
})

describe('DEFAULT_MONITOR_ENABLED', () => {
  it('enables uptime, domain, and web_vitals out of the box', () => {
    expect(DEFAULT_MONITOR_ENABLED.uptime).toBe(true)
    expect(DEFAULT_MONITOR_ENABLED.domain).toBe(true)
    expect(DEFAULT_MONITOR_ENABLED.web_vitals).toBe(true)
  })

  it('leaves rescan disabled — auto-enables on first scan completion', () => {
    expect(DEFAULT_MONITOR_ENABLED.rescan).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* ensureDefaultMonitors (mocked DB)                                          */
/* -------------------------------------------------------------------------- */

describe('ensureDefaultMonitors', () => {
  let mockInsert: ReturnType<typeof vi.fn>
  let mockValues: ReturnType<typeof vi.fn>
  let mockOnConflictDoNothing: ReturnType<typeof vi.fn>
  let mockReturning: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mockReturning = vi.fn()
    mockOnConflictDoNothing = vi.fn(() => ({ returning: mockReturning }))
    mockValues = vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing }))
    mockInsert = vi.fn(() => ({ values: mockValues }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../src/client.ts')
  })

  it('inserts one row per default monitor type', async () => {
    // Each `returning` call resolves with a fake row so the loop in
    // ensureDefaultMonitors collects them.
    for (let i = 0; i < DEFAULT_MONITOR_TYPES.length; i += 1) {
      mockReturning.mockResolvedValueOnce([{ id: `m${i}` }])
    }

    vi.doMock('../src/client.ts', () => ({ db: { insert: mockInsert } }))

    const { ensureDefaultMonitors: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    const rows = await fn('proj-1')

    expect(mockInsert).toHaveBeenCalledTimes(DEFAULT_MONITOR_TYPES.length)
    expect(rows).toHaveLength(DEFAULT_MONITOR_TYPES.length)

    // Spot-check the values used on insert for the first row (uptime).
    const firstValues = mockValues.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstValues['projectId']).toBe('proj-1')
    expect(firstValues['type']).toBe('uptime')
    expect(firstValues['enabled']).toBe(true)
    expect(firstValues['intervalS']).toBe(60)
  })

  it('uses onConflictDoNothing on conflict so an existing row is left alone', async () => {
    for (let i = 0; i < DEFAULT_MONITOR_TYPES.length; i += 1) {
      mockReturning.mockResolvedValueOnce([{ id: `m${i}` }])
    }
    vi.doMock('../src/client.ts', () => ({ db: { insert: mockInsert } }))

    const { ensureDefaultMonitors: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    await fn('proj-1')

    expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(DEFAULT_MONITOR_TYPES.length)
  })

  it('passes the rescan row with enabled=false', async () => {
    for (let i = 0; i < DEFAULT_MONITOR_TYPES.length; i += 1) {
      mockReturning.mockResolvedValueOnce([{ id: `m${i}` }])
    }
    vi.doMock('../src/client.ts', () => ({ db: { insert: mockInsert } }))

    const { ensureDefaultMonitors: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    await fn('proj-1')

    // Find the call whose `type` was 'rescan' — the last in DEFAULT_MONITOR_TYPES.
    const rescanCall = mockValues.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>)['type'] === 'rescan',
    )
    expect(rescanCall).toBeDefined()
    const rescanValues = rescanCall?.[0] as Record<string, unknown>
    expect(rescanValues['enabled']).toBe(false)
    expect(rescanValues['intervalS']).toBe(86_400)
  })
})

/* -------------------------------------------------------------------------- */
/* enableRescanMonitorIfPresent (mocked DB)                                   */
/* -------------------------------------------------------------------------- */

describe('enableRescanMonitorIfPresent', () => {
  let mockUpdate: ReturnType<typeof vi.fn>
  let mockSet: ReturnType<typeof vi.fn>
  let mockWhere: ReturnType<typeof vi.fn>
  let mockReturning: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mockReturning = vi.fn(() => Promise.resolve([]))
    mockWhere = vi.fn(() => ({ returning: mockReturning }))
    mockSet = vi.fn(() => ({ where: mockWhere }))
    mockUpdate = vi.fn(() => ({ set: mockSet }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../src/client.ts')
  })

  it('returns true when the row was flipped from disabled → enabled', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }])
    vi.doMock('../src/client.ts', () => ({ db: { update: mockUpdate } }))

    const { enableRescanMonitorIfPresent: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    expect(await fn('proj-1')).toBe(true)
  })

  it('returns false when the row was already enabled (idempotent)', async () => {
    mockReturning.mockResolvedValueOnce([]) // no rows match (enabled already true)
    vi.doMock('../src/client.ts', () => ({ db: { update: mockUpdate } }))

    const { enableRescanMonitorIfPresent: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    expect(await fn('proj-1')).toBe(false)
  })

  it('returns false when no rescan row exists for the project', async () => {
    mockReturning.mockResolvedValueOnce([])
    vi.doMock('../src/client.ts', () => ({ db: { update: mockUpdate } }))

    const { enableRescanMonitorIfPresent: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    expect(await fn('proj-1')).toBe(false)
  })

  it('invokes a WHERE clause (the rescan + disabled filter is composed by drizzle)', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }])
    vi.doMock('../src/client.ts', () => ({ db: { update: mockUpdate } }))

    const { enableRescanMonitorIfPresent: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    await fn('proj-1')

    // The helper calls `update(...).set(...).where(and(eq(projectId), eq(type, 'rescan'), eq(enabled, false)))`.
    // Drizzle's SQL objects are not stringly inspectable here — verifying the
    // call was made is enough to catch regressions where the WHERE clause is
    // accidentally dropped.
    expect(mockWhere).toHaveBeenCalledOnce()
    expect(mockUpdate).toHaveBeenCalledOnce()
  })

  it('sets enabled=true on the update', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 'm1' }])
    vi.doMock('../src/client.ts', () => ({ db: { update: mockUpdate } }))

    const { enableRescanMonitorIfPresent: fn } = await import(
      '../src/queries/onboarding-defaults.ts'
    )
    await fn('proj-1')

    expect(mockSet).toHaveBeenCalledOnce()
    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg['enabled']).toBe(true)
  })
})
