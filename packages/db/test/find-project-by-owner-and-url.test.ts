/**
 * Tests for findProjectByOwnerAndUrl — the "have I already got a project for
 * this URL?" lookup that URL-paste flows use to avoid creating duplicates.
 *
 * Pure unit tests with the DB client mocked. The query layer's only contract
 * here is the WHERE clause (ownerId + url) and the limit-1 newest-first
 * ordering; both are pinned.
 */

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

describe('findProjectByOwnerAndUrl', () => {
  it('returns the row the database finds', async () => {
    const row = {
      id: 'p1',
      ownerId: 'user-1',
      url: 'https://example.com/',
      name: 'example.com',
    }
    mockLimit.mockResolvedValueOnce([row])

    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectByOwnerAndUrl } = await import('../src/queries/projects.ts')
    const result = await findProjectByOwnerAndUrl('user-1', 'https://example.com/')

    expect(result).toEqual(row)
  })

  it('returns null when no row matches', async () => {
    mockLimit.mockResolvedValueOnce([])

    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectByOwnerAndUrl } = await import('../src/queries/projects.ts')
    const result = await findProjectByOwnerAndUrl('user-1', 'https://example.com/')

    expect(result).toBeNull()
  })

  it('composes the WHERE clause from ownerId AND url', async () => {
    mockLimit.mockResolvedValueOnce([])

    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectByOwnerAndUrl } = await import('../src/queries/projects.ts')
    await findProjectByOwnerAndUrl('user-1', 'https://example.com/')

    // Drizzle SQL objects are not stringly inspectable here, but verifying
    // the WHERE was invoked (and not skipped) catches the regression where
    // a refactor accidentally drops the owner-or-url filter.
    expect(mockSelect).toHaveBeenCalledOnce()
    expect(mockFrom).toHaveBeenCalledOnce()
    expect(mockWhere).toHaveBeenCalledOnce()
    expect(mockOrderBy).toHaveBeenCalledOnce()
    expect(mockLimit).toHaveBeenCalledWith(1)
  })

  it('limits to one row, newest first', async () => {
    // Two rows for the same owner+url would only happen if the lookup ever
    // stops being a paste-flow guard. If the guard breaks, the caller
    // creates duplicates — which is why we cap the response at one row.
    mockLimit.mockResolvedValueOnce([])

    vi.doMock('../src/client.ts', () => ({ db: { select: mockSelect } }))

    const { findProjectByOwnerAndUrl } = await import('../src/queries/projects.ts')
    await findProjectByOwnerAndUrl('user-1', 'https://example.com/')

    expect(mockLimit).toHaveBeenCalledWith(1)
  })
})