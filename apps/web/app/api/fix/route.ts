/**
 * Generate the fix prompt for one finding.
 *
 * The endpoint owns the three checks that make the feature safe to expose:
 *
 *   1. WHO — only a signed-in reader gets past the door.
 *   2. WHAT — the finding is looked up from the scan in the database by
 *      scanId + checkId. The request body never carries finding text, so
 *      nobody can make the model write fixes for content their plan never
 *      unlocked; redaction decided that when the report was served.
 *   3. WHICH — a finding the report redacted (locked) is refused here too:
 *      generating its fix would make the paywall theatre.
 *
 * Generation failures come back retryable — the free model tier throttles and
 * hiccups, and the UI answers those with a retry button rather than a dead
 * end. Paywall and configuration answers are not retryable: trying again
 * cannot change them.
 */

import { NextResponse } from 'next/server'
import { getScanForViewer } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { entitlementsFor } from '@/lib/entitlements.ts'
import { redactFindings } from '@/lib/redact.ts'
import { fixFailure, generateFix } from '@/lib/fixes.ts'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface FixRequestBody {
  scanId?: unknown
  checkId?: unknown
}

export async function POST(request: Request) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Sign in to generate fix prompts.' }, { status: 401 })
  }

  let body: FixRequestBody
  try {
    body = (await request.json()) as FixRequestBody
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }
  const { scanId, checkId } = body
  if (typeof scanId !== 'string' || !UUID.test(scanId)) {
    return NextResponse.json({ error: 'scanId is required' }, { status: 400 })
  }
  if (typeof checkId !== 'string' || checkId.trim() === '' || checkId.length > 200) {
    return NextResponse.json({ error: 'checkId is required' }, { status: 400 })
  }

  const scan = await getScanForViewer(scanId, viewer)
  // Not found, or belongs to someone else — one answer, no distinction.
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const entitlements = await entitlementsFor(viewer)
  const publicFinding = redactFindings(scan.findings, entitlements).findings.find(
    (finding) => finding.checkId === checkId,
  )
  if (!publicFinding) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (publicFinding.locked) {
    return NextResponse.json(
      {
        error: 'upgrade',
        message: 'The detail and the fix for this finding are part of Pro.',
      },
      { status: 403 },
    )
  }

  // Open for this reader means the full finding is theirs to work from — the
  // unredacted row comes from the database, not from the request.
  const full = scan.findings.find((finding) => finding.checkId === checkId)
  if (!full) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const result = await generateFix({
    checkId: full.checkId,
    category: full.category,
    severity: full.severity,
    title: full.title,
    description: full.description,
    evidence: full.evidence ?? null,
    remediation: full.remediation,
    siteUrl: scan.contextMeta?.finalUrl ?? scan.url,
  })

  if (result.ok) return NextResponse.json({ prompt: result.prompt })

  const failure = fixFailure(result.reason)
  return NextResponse.json(failure.body, { status: failure.status })
}
