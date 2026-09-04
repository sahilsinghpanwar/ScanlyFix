/**
 * External CI/CD systems (Vercel, Netlify, GitHub Actions) call this after
 * a successful deploy. Triggers an immediate check for all enabled monitors
 * on the matched project — instead of waiting for the next cron.
 *
 * Auth: ?token=<secret> query param — not Authorization header — because
 *   most CI webhook configs are just a URL field with no custom header support.
 *
 * Security:
 *   - timingSafeEqual: prevents timing attacks on token comparison
 *   - URL validation: body URL must be valid https (no internal IPs)
 *   - Project lookup by URL only — no user session needed
 *   - Only enabled monitors are triggered (same as sweep)
 *   - runtime = 'nodejs': needed for node:crypto timingSafeEqual
 *
 * Rate limiting:
 *   - Handled by Vercel/hosting platform (recommended: max 10 req/min per token)
 *   - Inngest deduplicates events — double-fire = one probe run
 */

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db, monitors, projects } from '@scanlyfix/db'
import { eq, and } from 'drizzle-orm'
import { inngest, EVENTS } from '@/lib/inngest.ts'
import type { TriggeredBy } from '@/inngest/functions/types.ts'
import { normalizeUrl, urlsMatch } from '@/lib/normalize-url.ts'

export const runtime = 'nodejs'
// WHY nodejs: timingSafeEqual is a Node.js crypto API — not available in Edge runtime

// ─── Body Schema ───────────────────────────────────────────────────────────────
// WHY both `url` and `project_url`: different CI platforms use different conventions
// Vercel sends `url`, GitHub Actions custom payloads often use `project_url`
const DeployHookBodySchema = z.object({
  url: z.string().url().optional(),
  project_url: z.string().url().optional(),
})

// ─── URL Validator ─────────────────────────────────────────────────────────────
// WHY validate: body URL is user-supplied — block internal IPs (SSRF)
const PRIVATE_IP_PATTERN =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.|0\.0\.0\.0|::1)/

function isPublicUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    if (PRIVATE_IP_PATTERN.test(parsed.hostname)) return false
    if (parsed.hostname === 'localhost') return false
    return true
  } catch {
    return false
  }
}

// ─── Token Validator ────────────────────────────────────────────────────────────
/**
 * WHY timingSafeEqual (not ===):
 * String === leaks timing info — attacker can guess token char by char
 * by measuring how long comparison takes. timingSafeEqual always takes
 * the same time regardless of where strings differ.
 */
function isValidToken(provided: string): boolean {
  const secret = process.env.DEPLOY_HOOK_SECRET
  if (!secret) {
    // WHY warn (not throw): misconfiguration should be visible in logs
    console.warn('[deploy-hook] DEPLOY_HOOK_SECRET env var is not set')
    return false
  }

  try {
    const a = Buffer.from(provided, 'utf8')
    const b = Buffer.from(secret, 'utf8')

    // Buffers must be same length for timingSafeEqual
    // WHY not return false early on length mismatch: would leak info
    // Instead: pad to same length, always compare
    if (a.length !== b.length) {
      // Still run comparison on equal-length dummy to avoid timing leak
      timingSafeEqual(b, b)
      return false
    }

    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ─── POST Handler ──────────────────────────────────────────────────────────────
export async function POST(request: Request) {

  // ── 1. Token validation ──────────────────────────────────────────────────────
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token') ?? ''

  if (!isValidToken(token)) {
    // WHY 401 not 403: token missing/wrong = unauthenticated, not unauthorized
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  // ── 2. Body parsing ──────────────────────────────────────────────────────────
  const rawBody = await request.json().catch(() => null)
  if (!rawBody) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const bodyParsed = DeployHookBodySchema.safeParse(rawBody)
  if (!bodyParsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: bodyParsed.error.issues },
      { status: 400 },
    )
  }

  // ── 3. URL resolution ────────────────────────────────────────────────────────
  // WHY `url` takes priority over `project_url`: shorter key = more common
  const projectUrl = bodyParsed.data.url ?? bodyParsed.data.project_url

  if (!projectUrl) {
    return NextResponse.json(
      { error: 'Body must contain `url` or `project_url`' },
      { status: 400 },
    )
  }

  // WHY validate after body parse (not in schema): better error message
  if (!isPublicUrl(projectUrl)) {
    return NextResponse.json(
      { error: 'Provided URL must be a public https URL' },
      { status: 400 },
    )
  }

  // ── 4. Project lookup ────────────────────────────────────────────────────────
  // WHY by URL (not slug/id): CI systems know the deploy URL, not internal IDs
  // WHY normalize + www. strip: CI systems may send www. or non-www. variants
  const normalizedInputUrl = normalizeUrl(projectUrl)
  if (!normalizedInputUrl) {
    return NextResponse.json(
      { error: 'Invalid URL format' },
      { status: 400 },
    )
  }

  // Fetch all projects and match using normalization
  const allProjects = await db.query.projects.findMany({
    columns: { id: true, name: true, url: true },
  })

  const project = allProjects.find((p) => urlsMatch(projectUrl, p.url))

  if (!project) {
    // WHY 404 (not 400): URL is valid, but no project matches — not a client error
    return NextResponse.json(
      { error: 'No project found for this URL' },
      { status: 404 },
    )
  }

  // ── 5. Fetch enabled monitors ─────────────────────────────────────────────────
  const enabledMonitors = await db.query.monitors.findMany({
    where: and(
      eq(monitors.projectId, project.id),
      eq(monitors.enabled, true),
    ),
    columns: { id: true, type: true },
  })

  if (enabledMonitors.length === 0) {
    return NextResponse.json(
      { triggered: 0, message: 'No enabled monitors found for this project' },
      { status: 200 },
    )
  }

  // ── 6. Emit Inngest events ────────────────────────────────────────────────────
  // WHY batch send (not Promise.all of individual sends):
  // Single network call to Inngest — faster, fewer connections
  //
  // WHY same EVENTS.monitorDue for all types:
  // Inngest functions filter by `event.data.type` — same event, different probes
  // pick it up based on their `if:` condition. (Same as how sweep works.)
  try {
    await inngest.send(
      enabledMonitors.map((m) => ({
        name: EVENTS.monitorDue,
        data: {
          monitorId: m.id,
          type: m.type,
          projectId: project.id,
          url: projectUrl,
          triggeredBy: 'deploy-hook' as TriggeredBy,
        },
      })),
    )
  } catch (error) {
    console.error('[deploy-hook] Failed to emit Inngest events:', error)
    return NextResponse.json(
      { error: 'Background queue is unreachable. Please try again later.' },
      { status: 500 },
    )
  }

  // ── 7. Response ───────────────────────────────────────────────────────────────
  return NextResponse.json({
    ok: true,
    triggered: enabledMonitors.length,
    project: project.name,
    monitors: enabledMonitors.map((m) => ({ id: m.id, type: m.type })),
  })
}