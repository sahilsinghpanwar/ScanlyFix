/**
 * apps/web/test/monitor-run-route.test.ts
 *
 * Tests for POST /api/monitors/[id]/run.
 *
 * What this guards:
 *   - Anonymous → 401 (no DB read, no event sent)
 *   - Bad UUID  → 400 (no DB read, no event sent)
 *   - Monitor not found → 404 (no event sent)
 *   - Monitor exists but belongs to another user → 404 (no event sent,
 *     same message so existence is not leaked)
 *   - Happy path → emits one `monitorDue` event with the right
 *     payload shape, including `triggeredBy: 'manual'`
 *
 * What is NOT here:
 *   - The actual probe running — that lives in the inngest worker
 *     and is exercised by the integration suite, not by route tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockViewer, mockFindFirst, mockGetProject, mockSendInngest } = vi.hoisted(() => ({
  mockViewer: vi.fn(),
  mockFindFirst: vi.fn(),
  mockGetProject: vi.fn(),
  mockSendInngest: vi.fn(),
}))

vi.mock('@/lib/authz.ts', () => ({
  getViewer: () => mockViewer(),
}))

vi.mock('@scanlyfix/db', () => ({
  db: {
    query: {
      monitors: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
  },
  getProject: (...args: unknown[]) => mockGetProject(...args),
  monitors: { id: 'id' },
}))

vi.mock('@/lib/inngest.ts', () => ({
  inngest: { send: (...args: unknown[]) => mockSendInngest(...args) },
  EVENTS: { monitorDue: 'scanlyfix/monitor.due' },
}))

const { POST } = await import('../app/api/monitors/[id]/run/route.ts')

const USER = { kind: 'user', userId: 'usr-1' }
const ANON = { kind: 'anonymous' }
const MONITOR_ID = '550e8400-e29b-41d4-a716-446655440000'

function ctx() {
  return { params: Promise.resolve({ id: MONITOR_ID }) }
}

beforeEach(() => {
  mockViewer.mockReset()
  mockFindFirst.mockReset()
  mockGetProject.mockReset()
  mockSendInngest.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/monitors/[id]/run', () => {
  it('returns 401 when the viewer is anonymous', async () => {
    mockViewer.mockResolvedValue(ANON)
    const res = await POST(new Request('https://app.test/api/monitors/x/run', { method: 'POST' }), ctx())
    expect(res.status).toBe(401)
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockSendInngest).not.toHaveBeenCalled()
  })

  it('returns 400 when the monitor id is not a UUID', async () => {
    mockViewer.mockResolvedValue(USER)
    const res = await POST(
      new Request('https://app.test/api/monitors/x/run', { method: 'POST' }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    )
    expect(res.status).toBe(400)
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockSendInngest).not.toHaveBeenCalled()
  })

  it('returns 404 when no monitor row matches', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindFirst.mockResolvedValue(null)
    const res = await POST(new Request('https://app.test/api/monitors/x/run', { method: 'POST' }), ctx())
    expect(res.status).toBe(404)
    expect(mockSendInngest).not.toHaveBeenCalled()
  })

  it('returns 404 when the project lookup rejects the viewer (other user owns it)', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindFirst.mockResolvedValue({
      id: MONITOR_ID,
      type: 'uptime',
      enabled: true,
      projectId: 'proj-1',
    })
    mockGetProject.mockResolvedValue(null)
    const res = await POST(new Request('https://app.test/api/monitors/x/run', { method: 'POST' }), ctx())
    expect(res.status).toBe(404)
    expect(mockSendInngest).not.toHaveBeenCalled()
  })

  it('emits one monitorDue event with triggeredBy=manual on the happy path', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindFirst.mockResolvedValue({
      id: MONITOR_ID,
      type: 'uptime',
      enabled: true,
      projectId: 'proj-1',
    })
    mockGetProject.mockResolvedValue({
      id: 'proj-1',
      url: 'https://example.com',
      ownerId: USER.userId,
    })
    mockSendInngest.mockResolvedValue({ ids: ['evt-1'] })

    const res = await POST(new Request('https://app.test/api/monitors/x/run', { method: 'POST' }), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, monitorId: MONITOR_ID })

    expect(mockSendInngest).toHaveBeenCalledTimes(1)
    const firstCall = mockSendInngest.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [payload] = firstCall as [unknown]
    expect(payload).toEqual({
      name: 'scanlyfix/monitor.due',
      data: {
        monitorId: MONITOR_ID,
        type: 'uptime',
        projectId: 'proj-1',
        url: 'https://example.com',
        triggeredBy: 'manual',
      },
    })
  })

  it('still emits for a disabled monitor — the user explicitly asked', async () => {
    // Disabling the cron should not also disable the manual escape
    // hatch. The button only exists on the monitor the user already
    // owns, and they want to run it NOW regardless of schedule.
    mockViewer.mockResolvedValue(USER)
    mockFindFirst.mockResolvedValue({
      id: MONITOR_ID,
      type: 'domain',
      enabled: false,
      projectId: 'proj-1',
    })
    mockGetProject.mockResolvedValue({
      id: 'proj-1',
      url: 'https://example.com',
      ownerId: USER.userId,
    })
    mockSendInngest.mockResolvedValue({ ids: ['evt-1'] })

    const res = await POST(new Request('https://app.test/api/monitors/x/run', { method: 'POST' }), ctx())
    expect(res.status).toBe(200)
    expect(mockSendInngest).toHaveBeenCalledTimes(1)
    const firstCall = mockSendInngest.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [payload] = firstCall as [unknown]
    expect((payload as { data: { type: string } }).data.type).toBe('domain')
  })

  it('returns 500 when inngest.send fails (queue is down)', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindFirst.mockResolvedValue({
      id: MONITOR_ID,
      type: 'uptime',
      enabled: true,
      projectId: 'proj-1',
    })
    mockGetProject.mockResolvedValue({
      id: 'proj-1',
      url: 'https://example.com',
      ownerId: USER.userId,
    })
    mockSendInngest.mockRejectedValue(new Error('fetch failed (ECONNREFUSED)'))

    const res = await POST(new Request('https://app.test/api/monitors/x/run', { method: 'POST' }), ctx())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/unreachable|unavailable/i)
  })
})
