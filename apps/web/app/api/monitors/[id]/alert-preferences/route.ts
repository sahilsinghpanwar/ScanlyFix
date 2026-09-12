/**
 * GET  /api/monitors/[id]/alert-preferences
 * PATCH /api/monitors/[id]/alert-preferences
 *
 * Lightweight endpoint that stores the two fields the uptime page's settings
 * row needs: how many failures in a row trigger an alert, and where the
 * alert should go.
 *
 * Why a separate endpoint instead of the existing /config route:
 *   - /config is the heavy endpoint (keyword check, custom headers, etc.)
 *     and is on the slow path of probe evaluation. The uptime page should
 *     never have to wait on the full config round-trip just to read two
 *     scalar values.
 *   - /config's parser validates the entire AlertConfig; the uptime page's
 *     settings row should not be able to silently corrupt the rest of the
 *     config by accident.
 *
 * Body (PATCH):
 *   { failuresBeforeAlert: 1|2|3|5, alertEmail: string|null }
 *
 * Auth: viewer must own the monitor's project.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, monitors, projects } from '@scanlyfix/db'
import { eq } from 'drizzle-orm'
import { getViewer } from '@/lib/authz.ts'
import { parseAlertConfig, type AlertConfig } from '@/lib/alert-threshold.ts'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PatchSchema = z.object({
  failuresBeforeAlert: z.number().int().min(1).max(5),
  alertEmail: z
    .string()
    .trim()
    .email()
    .nullable()
    .or(z.literal('').transform(() => null)),
})

const FAILURES_DEFAULT = 2

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'Invalid monitor ID' }, { status: 400 })
  }

  try {
    const monitor = await db.query.monitors.findFirst({
      where: eq(monitors.id, id),
      columns: { id: true, projectId: true, alertConfig: true },
    })
    if (!monitor) {
      return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
    }
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, monitor.projectId),
      columns: { ownerId: true },
    })
    if (!project || project.ownerId !== viewer.userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const parsed = parseAlertConfig(monitor.alertConfig ?? {})
    const config = parsed.ok ? parsed.config : ({} as AlertConfig)
    return NextResponse.json({
      failuresBeforeAlert:
        config.failuresBeforeAlert ?? FAILURES_DEFAULT,
      alertEmail: config.alertEmail ?? null,
    })
  } catch (err) {
    console.error(`[alert-preferences] GET failed:`, err)
    return NextResponse.json(
      { error: 'Failed to fetch alert preferences' },
      { status: 500 },
    )
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'Invalid monitor ID' }, { status: 400 })
  }

  const raw = await req.json().catch(() => null)
  const parsed = PatchSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid body' },
      { status: 400 },
    )
  }

  try {
    const monitor = await db.query.monitors.findFirst({
      where: eq(monitors.id, id),
      columns: { id: true, projectId: true, alertConfig: true },
    })
    if (!monitor) {
      return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
    }
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, monitor.projectId),
      columns: { ownerId: true },
    })
    if (!project || project.ownerId !== viewer.userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const existingAlertConfig =
      typeof monitor.alertConfig === 'object' && monitor.alertConfig !== null
        ? (monitor.alertConfig as Record<string, unknown>)
        : {}

    const normalizedEmail =
      typeof parsed.data.alertEmail === 'string' && parsed.data.alertEmail.trim().length > 0
        ? parsed.data.alertEmail.trim()
        : null

    const nextConfig: AlertConfig = {
      ...existingAlertConfig,
      failuresBeforeAlert: parsed.data.failuresBeforeAlert,
      alertEmail: normalizedEmail,
    }

    const updatePayload = Object.assign(
      { alertConfig: nextConfig },
      nextConfig,
    )

    await db
      .update(monitors)
      .set(updatePayload as any)
      .where(eq(monitors.id, id))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error(`[alert-preferences] PATCH failed:`, err)
    return NextResponse.json(
      { error: 'Failed to update alert preferences' },
      { status: 500 },
    )
  }
}
