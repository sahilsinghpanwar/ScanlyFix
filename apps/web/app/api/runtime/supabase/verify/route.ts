import { NextResponse } from 'next/server';

import { getCanaryProjectConfig, listCanaries, markCanariesSetup } from '@scanlyfix/db';

import { getViewer } from '@/lib/authz';
import { getProject } from '@scanlyfix/db';
import { decryptValue } from '@/lib/header-encryption';
import { sha256Canonical } from '@/lib/runtime/canaries/integrity';
import { restSelect } from '@/lib/runtime/canaries/supabase-rest';
import { CANARY_LOG_TABLE, CANARY_TABLE } from '@/lib/runtime/canaries/types';

/** User SQL run karke aaya — service key se vault table dikh rahi? Markers match? Snapshot le lo. */
export async function POST(req: Request): Promise<NextResponse> {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') return NextResponse.json({ ok: false }, { status: 401 });

  const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!projectId) return NextResponse.json({ ok: false }, { status: 400 });

  const project = await getProject(projectId, viewer);
  if (!project) return NextResponse.json({ ok: false }, { status: 404 });

  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  if (!cfg) return NextResponse.json({ ok: false, error: 'connect_supabase_first' }, { status: 400 });

  const rest = { url: cfg.supabaseUrl, serviceKey: cfg.serviceKey };
  const rows = await restSelect<{ marker: string; payload: unknown }>(rest, CANARY_TABLE, { query: 'select=marker,payload' });
  const log = await restSelect<{ id: number }>(rest, CANARY_LOG_TABLE, { query: 'select=id', withCount: true });

  if (rows.status === 404) {
    return NextResponse.json({ ok: false, error: 'table_not_found — SQL script run hua?' }, { status: 400 });
  }
  if (!rows.ok || !rows.data) {
    return NextResponse.json({ ok: false, error: `rest_error_${rows.status}` }, { status: 502 });
  }

  const canaries = await listCanaries(projectId);
  const found = new Set(rows.data.map((r) => r.marker));
  const missing = canaries.filter((c) => !found.has(c.markerToken));
  if (missing.length > 0) {
    return NextResponse.json({ ok: false, error: `markers missing: ${missing.map((m) => m.markerToken).join(', ')}` }, { status: 400 });
  }

  // Pehla snapshot mirror — tamper-evidence ka baseline
  const payloadHashes: Record<string, string> = {};
  for (const r of rows.data) {
    payloadHashes[r.marker] = sha256Canonical(r.payload);
  }

  await markCanariesSetup(projectId, {
    payloadHashes,
    logRowCount: log.count ?? 0,
    takenAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, rows: rows.data.length });
}