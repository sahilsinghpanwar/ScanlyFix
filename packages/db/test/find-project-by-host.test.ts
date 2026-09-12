import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockSelect: ReturnType<typeof vi.fn>
let mockFrom: ReturnType<typeof vi.fn>
let mockWhere: ReturnType<typeof vi.fn>
let mockOrderBy: ReturnType<typeof vi.fn>
let mockLimit: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mockLimit = vi.fn(() => Promise.resolve([]))
  mockOrderBy = vi.fn(() => ({ limit: mockLimit }))
  mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }))
  mockFrom = vi.fn(() => ({ where: mockWhere }))
  mockSelect = vi.fn(() => ({ from: mockFrom }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../src/client.ts')
})

describe('normalizeHost', () => {
  it('handles various domain and URL formats accurately', async () => {
    const { normalizeHost } = await import('../src/queries/projects.ts')

    expect(normalizeHost('https://live-shop-mu.vercel.app/')).toBe('live-shop-mu.vercel.app')
    expect(normalizeHost('http://mock-interview-seven-swart.vercel.app')).toBe('mock-interview-seven-swart.vercel.app')
    expect(normalizeHost('https://www.example.com/api/test')).toBe('example.com')
    expect(normalizeHost('www.example.com:443')).toBe('example.com')
    expect(normalizeHost('localhost:3000')).toBe('localhost:3000')
    expect(normalizeHost('http://localhost:3001/')).toBe('localhost:3001')
  })
})

describe('findProjectIdByHost', () => {
  it('returns project ID when exact normalized host matches candidate URL', async () => {
    const candidate = {
      id: 'proj-123',
      url: 'https://live-shop-mu.vercel.app/',
      name: 'live-shop-mu.vercel.app',
    }
    mockLimit.mockResolvedValueOnce([candidate])
    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectIdByHost } = await import('../src/queries/projects.ts')
    const result = await findProjectIdByHost('live-shop-mu.vercel.app')

    expect(result).toBe('proj-123')
  })

  it('matches host ignoring www. prefix', async () => {
    const candidate = {
      id: 'proj-456',
      url: 'https://www.policybazaar.com/',
      name: 'policybazaar',
    }
    mockLimit.mockResolvedValueOnce([candidate])
    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectIdByHost } = await import('../src/queries/projects.ts')
    const result = await findProjectIdByHost('policybazaar.com')

    expect(result).toBe('proj-456')
  })

  it('matches host with port in local dev', async () => {
    const candidate = {
      id: 'proj-local',
      url: 'http://localhost:3001/',
      name: 'local-test-app',
    }
    mockLimit.mockResolvedValueOnce([candidate])
    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectIdByHost } = await import('../src/queries/projects.ts')
    const result = await findProjectIdByHost('localhost:3001')

    expect(result).toBe('proj-local')
  })

  it('returns null when no candidate matches', async () => {
    mockLimit.mockResolvedValueOnce([])
    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectIdByHost } = await import('../src/queries/projects.ts')
    const result = await findProjectIdByHost('unknown-domain.com')

    expect(result).toBeNull()
  })

  it('returns null for empty or invalid input safely', async () => {
    const { findProjectIdByHost } = await import('../src/queries/projects.ts')
    expect(await findProjectIdByHost('')).toBeNull()
    expect(await findProjectIdByHost('   ')).toBeNull()
    expect(await findProjectIdByHost(null as any)).toBeNull()
  })
})
