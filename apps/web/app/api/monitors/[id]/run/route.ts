/**
 * POST /api/monitors/[id]/run
 *
 * Manual run trigger — a "Run check now" button on the monitor detail
 * page calls this. The route does not perform the probe itself: it
 * emits the same `monitorDue` Inngest event the cron sweep does,
 * with `triggeredBy: 'manual'`, and the existing probe functions
 * pick it up the same way they would a scheduled run.
 *
 * ## Why an event, not an inline probe
 *
 *   - The probes own the HTTP request, the row insert and the alert
 *     path. Forcing a second probe code path would duplicate them.
 *   - Inngest already gives us a queue, a concurrency ceiling per
 *     function and an at-least-once delivery guarantee. Doing the
 *     same work synchronously here would either block the request
 *     or hide a parallel one that the cron sweep just emitted.
 *
 * ## Auth
 *
 *   - Signed-in user only (the button is not visible to anonymous
 *     viewers; this route assumes the page already redirected).
 *   - The monitor's project must belong to the caller. We re-check
 *     on every request rather than trusting the URL, because the
 *     monitor id comes off the wire — a UUID is a guess away from
 *     somebody else's row.
 *
 * ## Idempotency
 *
 * Two clicks in quick succession fire two `monitorDue` events. The
 * probes dedupe on `monitorId` (the row update is `WHERE ts >= now()`,
 * the last one wins) so the user sees one new log entry, not two.
 * We do NOT debounce at the route — the user expects "I clicked
 * twice = two checks", and the only cost of the second one is a
 * single extra row.
 *
 * ## Errors
 *
 *   400 — bad monitor id
 *   401 — anonymous
 *   404 — monitor not found / not owned
 *   500 — Inngest send failed (the queue is down)
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, getProject, monitors } from '@scanlyfix/db'
import { eq } from 'drizzle-orm'
import { inngest, EVENTS } from '@/lib/inngest.ts'
import { getViewer } from '@/lib/authz.ts'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid monitor ID' }, { status: 400 })
  }

  // Look up the monitor, then the project it belongs to. The
  // project lookup is the authorization step — `getProject` checks
  // ownership, so a monitor that exists but belongs to somebody
  // else returns `null` and we 404 without distinguishing the two
  // cases (telling them apart would leak row existence).
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, id),
    columns: { id: true, type: true, enabled: true, projectId: true },
  })

  if (!monitor) {
    return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
  }

  const project = await getProject(monitor.projectId, viewer)
  if (!project) {
    return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
  }

  // Even a disabled monitor can be run by hand — the user explicitly
  // asked for it, so disabling the cron should not also disable the
  // escape hatch. (Same shape as deploy-hook: filter is on `enabled`
  // there because deploy-hook triggers a batch of monitors and
  // disabled ones would surprise the user; here the user picked
  // the row themselves.)
  try {
    await inngest.send({
      name: EVENTS.monitorDue,
      data: {
        monitorId: monitor.id,
        type: monitor.type,
        projectId: project.id,
        url: project.url,
        triggeredBy: 'manual',
      },
    })
  } catch (error) {
    console.error(`[api/monitors/run] Failed to dispatch monitor ${monitor.id}:`, error)
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV !== 'production'
            ? 'Background queue is unreachable. In development, please make sure Inngest Dev Server is running (`npx inngest-cli@latest dev`).'
            : 'The background queue is currently unavailable. Please try again later.',
      },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, monitorId: monitor.id })
}
