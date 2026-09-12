/**
 * Tests for GET/PATCH /api/monitors/[id]/alert-preferences
 *
 * The endpoint owns two fields the uptime settings row needs:
 *   - failuresBeforeAlert: 1 | 2 | 3 | 5
 *   - alertEmail:           string | null
 *
 * It must:
 *   1. Authorize correctly — anon → 401, wrong project → 403, unknown id → 404
 *   2. Validate the PATCH body (range, email format)
 *   3. Merge into the existing alertConfig without dropping other fields
 *   4. Default failuresBeforeAlert to 2 when the row has no config yet
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockViewer,
  mockFindMonitor,
  mockFindProject,
  mockUpdateMonitor,
} = vi.hoisted(() => ({
  mockViewer: vi.fn(),
  mockFindMonitor: vi.fn(),
  mockFindProject: vi.fn(),
  mockUpdateMonitor: vi.fn(),
}))

vi.mock('@/lib/authz.ts', () => ({
  getViewer: () => mockViewer(),
}))

vi.mock('@scanlyfix/db', () => ({
  db: {
    query: {
      monitors: {
        findFirst: (...args: unknown[]) => mockFindMonitor(...args),
      },
      projects: {
        findFirst: (...args: unknown[]) => mockFindProject(...args),
      },
    },
    update: (...args: unknown[]) => mockUpdateMonitor(...args),
  },
  monitors: { id: 'id' },
  projects: { id: 'id' },
}))

const { GET, PATCH } = await import(
  '../app/api/monitors/[id]/alert-preferences/route.ts'
)

const USER = { kind: 'user', userId: 'usr-1' }
const ANON = { kind: 'anonymous' }
const MONITOR_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = { kind: 'user', userId: 'usr-2' }

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function get() {
  return GET(
    new Request(`http://app.test/api/monitors/${MONITOR_ID}/alert-preferences`),
    ctx(MONITOR_ID),
  )
}

function patch(body: unknown) {
  return PATCH(
    new Request(`http://app.test/api/monitors/${MONITOR_ID}/alert-preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx(MONITOR_ID),
  )
}

beforeEach(() => {
  mockViewer.mockReset()
  mockFindMonitor.mockReset()
  mockFindProject.mockReset()
  mockUpdateMonitor.mockReset()

  // Build a tiny fluent mock: db.update(monitors).set({...}).where(...)
  mockUpdateMonitor.mockImplementation(() => ({
    set: () => ({
      where: async () => undefined,
    }),
  }))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/monitors/[id]/alert-preferences', () => {
  it('returns 401 for anonymous viewers', async () => {
    mockViewer.mockResolvedValue(ANON)
    const res = await get()
    expect(res.status).toBe(401)
  })

  it('returns 400 for malformed monitor ids', async () => {
    mockViewer.mockResolvedValue(USER)
    const res = await GET(
      new Request('http://app.test/api/monitors/not-a-uuid/alert-preferences'),
      ctx('not-a-uuid'),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the monitor does not exist', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindMonitor.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(404)
  })

  it('returns 403 when the viewer does not own the project', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindMonitor.mockResolvedValue({ id: MONITOR_ID, projectId: 'proj-1', alertConfig: {} })
    mockFindProject.mockResolvedValue({ ownerId: 'usr-other' })
    const res = await get()
    expect(res.status).toBe(403)
  })

  it('returns defaults when alertConfig is empty', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindMonitor.mockResolvedValue({ id: MONITOR_ID, projectId: 'proj-1', alertConfig: null })
    mockFindProject.mockResolvedValue({ ownerId: USER.userId })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ failuresBeforeAlert: 2, alertEmail: null })
  })

  it('returns stored values when present', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindMonitor.mockResolvedValue({
      id: MONITOR_ID,
      projectId: 'proj-1',
      alertConfig: { failuresBeforeAlert: 3, alertEmail: 'oncall@example.com' },
    })
    mockFindProject.mockResolvedValue({ ownerId: USER.userId })
    const res = await get()
    const body = await res.json()
    expect(body).toEqual({ failuresBeforeAlert: 3, alertEmail: 'oncall@example.com' })
  })
})

describe('PATCH /api/monitors/[id]/alert-preferences', () => {
  it('returns 401 for anonymous viewers', async () => {
    mockViewer.mockResolvedValue(ANON)
    const res = await patch({ failuresBeforeAlert: 2, alertEmail: null })
    expect(res.status).toBe(401)
  })

  it('rejects out-of-range failuresBeforeAlert', async () => {
    mockViewer.mockResolvedValue(USER)
    const res = await patch({ failuresBeforeAlert: 6, alertEmail: null })
    expect(res.status).toBe(400)
  })

  it('rejects invalid email', async () => {
    mockViewer.mockResolvedValue(USER)
    const res = await patch({ failuresBeforeAlert: 2, alertEmail: 'not-an-email' })
    expect(res.status).toBe(400)
  })

  it('accepts a valid update and merges with existing config', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindMonitor.mockResolvedValue({
      id: MONITOR_ID,
      projectId: 'proj-1',
      alertConfig: { failStatusCodes: [500, 502] }, // unrelated field must survive
    })
    mockFindProject.mockResolvedValue({ ownerId: USER.userId })

    let capturedConfig: unknown = null
    mockUpdateMonitor.mockImplementation((_table: unknown) => ({
      set: (cfg: unknown) => {
        capturedConfig = cfg
        return { where: async () => undefined }
      },
    }))

    const res = await patch({
      failuresBeforeAlert: 5,
      alertEmail: 'alerts@example.com',
    })
    expect(res.status).toBe(200)
    expect((capturedConfig as { alertConfig: unknown }).alertConfig).toMatchObject({
      failStatusCodes: [500, 502],
      failuresBeforeAlert: 5,
      alertEmail: 'alerts@example.com',
    })
  })

  it('treats empty string email as null', async () => {
    mockViewer.mockResolvedValue(USER)
    mockFindMonitor.mockResolvedValue({
      id: MONITOR_ID,
      projectId: 'proj-1',
      alertConfig: {},
    })
    mockFindProject.mockResolvedValue({ ownerId: USER.userId })

    let capturedConfig: unknown = null
    mockUpdateMonitor.mockImplementation((_table: unknown) => ({
      set: (cfg: unknown) => {
        capturedConfig = cfg
        return { where: async () => undefined }
      },
    }))

    const res = await patch({ failuresBeforeAlert: 2, alertEmail: '' })
    expect(res.status).toBe(200)
    expect((capturedConfig as { alertConfig?: { alertEmail?: unknown } }).alertConfig?.alertEmail).toBeNull()
  })

  it('returns 403 when the viewer does not own the project', async () => {
    mockViewer.mockResolvedValue(OTHER_USER)
    mockFindMonitor.mockResolvedValue({ id: MONITOR_ID, projectId: 'proj-1', alertConfig: {} })
    mockFindProject.mockResolvedValue({ ownerId: 'someone-else' })
    const res = await patch({ failuresBeforeAlert: 2, alertEmail: null })
    expect(res.status).toBe(403)
  })
})
