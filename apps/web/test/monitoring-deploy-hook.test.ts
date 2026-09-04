/**
 * Tests for the On-Deploy Trigger (/api/monitors/deploy-hook).
 *
 * Checks:
 *   - Token authentication (?token=<secret>)
 *   - URL validation & SSRF prevention (private IPs, localhost)
 *   - Both `url` and `project_url` in request payload
 *   - Project resolution and event emission via Inngest
 *   - Response codes (401, 400, 404, 200)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../app/api/monitors/deploy-hook/route.ts'

const { findManyProjects, findManyMonitors, sendInngest } = vi.hoisted(() => ({
  findManyProjects: vi.fn(),
  findManyMonitors: vi.fn(),
  sendInngest: vi.fn(),
}))

vi.mock('@scanlyfix/db', () => ({
  db: {
    query: {
      projects: { findMany: findManyProjects },
      monitors: { findMany: findManyMonitors },
    },
  },
  projects: { url: 'url', id: 'id' },
  monitors: { projectId: 'projectId', enabled: 'enabled' },
}))

vi.mock('@/lib/inngest.ts', () => ({
  inngest: { send: sendInngest },
  EVENTS: { monitorDue: 'scanlyfix/monitor.due' },
}))

const SECRET = 'test-deploy-secret-12345'

beforeEach(() => {
  vi.stubEnv('DEPLOY_HOOK_SECRET', SECRET)
  findManyProjects.mockReset()
  findManyMonitors.mockReset()
  sendInngest.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function makeRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/monitors/deploy-hook', () => {
  describe('Authentication', () => {
    it('returns 401 when token query param is missing', async () => {
      const req = makeRequest('https://app.test/api/monitors/deploy-hook', {
        url: 'https://example.com',
      })
      const res = await POST(req)
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Invalid token')
    })

    it('returns 401 when token is incorrect', async () => {
      const req = makeRequest(
        'https://app.test/api/monitors/deploy-hook?token=wrong-token',
        { url: 'https://example.com' },
      )
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('returns 401 when DEPLOY_HOOK_SECRET env var is not set', async () => {
      vi.stubEnv('DEPLOY_HOOK_SECRET', '')
      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { url: 'https://example.com' },
      )
      const res = await POST(req)
      expect(res.status).toBe(401)
    })
  })

  describe('Payload & URL validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      const req = new Request(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        },
      )
      const res = await POST(req)
      expect(res.status).toBe(400)
    })

    it('returns 400 when neither url nor project_url is provided', async () => {
      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { somethingElse: 123 },
      )
      const res = await POST(req)
      expect(res.status).toBe(400)
    })

    it('returns 400 when url is a private IP / localhost (SSRF protection)', async () => {
      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { url: 'https://127.0.0.1/app' },
      )
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('public https URL')
    })

    it('returns 400 when url is http:// (not public https/http public)', async () => {
      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { url: 'http://192.168.1.1/app' },
      )
      const res = await POST(req)
      expect(res.status).toBe(400)
    })
  })

  describe('Project lookup & execution', () => {
    it('returns 404 when no project matches the given URL', async () => {
      findManyProjects.mockResolvedValue([])

      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { url: 'https://unknown-site.example.com' },
      )
      const res = await POST(req)
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('No project found for this URL')
    })

    it('returns 200 with triggered:0 when project has no enabled monitors', async () => {
      findManyProjects.mockResolvedValue([{ id: 'proj-1', name: 'My Project', url: 'https://mysite.example.com' }])
      findManyMonitors.mockResolvedValue([])

      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { url: 'https://mysite.example.com' },
      )
      const res = await POST(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.triggered).toBe(0)
      expect(sendInngest).not.toHaveBeenCalled()
    })

    it('triggers Inngest events with triggeredBy: deploy-hook for enabled monitors', async () => {
      findManyProjects.mockResolvedValue([{ id: 'proj-1', name: 'My Project', url: 'https://mysite.example.com' }])
      findManyMonitors.mockResolvedValue([
        { id: 'mon-1', type: 'uptime' },
        { id: 'mon-2', type: 'domain' },
      ])
      sendInngest.mockResolvedValue({ ids: ['evt-1', 'evt-2'] })

      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { url: 'https://mysite.example.com' },
      )
      const res = await POST(req)
      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.triggered).toBe(2)
      expect(data.project).toBe('My Project')

      expect(sendInngest).toHaveBeenCalledWith([
        {
          name: 'scanlyfix/monitor.due',
          data: {
            monitorId: 'mon-1',
            type: 'uptime',
            projectId: 'proj-1',
            url: 'https://mysite.example.com',
            triggeredBy: 'deploy-hook',
          },
        },
        {
          name: 'scanlyfix/monitor.due',
          data: {
            monitorId: 'mon-2',
            type: 'domain',
            projectId: 'proj-1',
            url: 'https://mysite.example.com',
            triggeredBy: 'deploy-hook',
          },
        },
      ])
    })

    it('accepts project_url as an alternate field name', async () => {
      findManyProjects.mockResolvedValue([{ id: 'proj-1', name: 'My Project', url: 'https://mysite.example.com' }])
      findManyMonitors.mockResolvedValue([{ id: 'mon-1', type: 'uptime' }])
      sendInngest.mockResolvedValue({ ids: ['evt-1'] })

      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { project_url: 'https://mysite.example.com' },
      )
      const res = await POST(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.triggered).toBe(1)
    })

    it('returns 500 when inngest.send fails', async () => {
      findManyProjects.mockResolvedValue([{ id: 'proj-1', name: 'My Project', url: 'https://mysite.example.com' }])
      findManyMonitors.mockResolvedValue([{ id: 'mon-1', type: 'uptime' }])
      sendInngest.mockRejectedValue(new Error('fetch failed (ECONNREFUSED)'))

      const req = makeRequest(
        `https://app.test/api/monitors/deploy-hook?token=${SECRET}`,
        { url: 'https://mysite.example.com' },
      )
      const res = await POST(req)
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toMatch(/unreachable|unavailable/i)
    })
  })
})
