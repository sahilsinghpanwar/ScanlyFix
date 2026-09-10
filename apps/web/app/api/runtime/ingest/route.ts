import { NextResponse, type NextRequest } from 'next/server';
import { recordRouteEvents, recordAiCallEvents, type IngestRouteEvent, type IngestAiCallEvent } from '@scanlyfix/db';
import { estimateCostMicroUsd } from '@scanlyfix/runtime-sdk';

export const runtime = 'nodejs';

type IngestPayloadEvent =
  | (IngestRouteEvent & { type?: 'route' })
  | {
      type: 'ai_call';
      provider: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      latencyMs?: number;
      costMicroUsd?: number;
      userHash?: string | null;
    };

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const rawProjectId =
      req.headers.get('x-runtime-project-id') ??
      url.searchParams.get('projectId');

    const projectId = rawProjectId?.trim();
    if (!projectId) {
      return NextResponse.json({ ok: false, error: 'missing_project_id' }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as { events?: IngestPayloadEvent[] } | null;
    if (!body || !Array.isArray(body.events)) {
      return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
    }

    const routeEvents: IngestRouteEvent[] = [];
    const aiEvents: IngestAiCallEvent[] = [];

    for (const ev of body.events) {
      if (!ev || typeof ev !== 'object') continue;

      if (ev.type === 'ai_call') {
        const promptTokens = Math.max(0, Number(ev.promptTokens) || 0);
        const completionTokens = Math.max(0, Number(ev.completionTokens) || 0);
        const model = String(ev.model || 'unknown');
        const provider = String(ev.provider || 'unknown');
        // Server recalculates cost to avoid trusting client values
        const costMicroUsd = estimateCostMicroUsd(model, promptTokens, completionTokens);

        aiEvents.push({
          provider,
          model,
          promptTokens,
          completionTokens,
          latencyMs: Math.max(0, Number(ev.latencyMs) || 0),
          costMicroUsd,
          userHash: typeof ev.userHash === 'string' && ev.userHash.length > 0 ? ev.userHash.slice(0, 64) : null,
        });
      } else if ('pattern' in ev && 'method' in ev) {
        const routeEv = ev as IngestRouteEvent;
        if (routeEv.pattern && routeEv.method) {
          routeEvents.push({
            pattern: String(routeEv.pattern),
            method: String(routeEv.method),
            kind: routeEv.kind,
            hasSession: Boolean(routeEv.hasSession),
          });
        }
      }
    }

    let recordedRoutes = 0;
    let recordedAi = 0;

    if (routeEvents.length > 0) {
      recordedRoutes = await recordRouteEvents(projectId, routeEvents);
    }
    if (aiEvents.length > 0) {
      recordedAi = await recordAiCallEvents(projectId, aiEvents);
    }

    return NextResponse.json({
      ok: true,
      recorded: recordedRoutes + recordedAi,
      recordedRoutes,
      recordedAi,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/invalid input syntax for type uuid|violates foreign key constraint/i.test(msg)) {
      return NextResponse.json({ ok: false, error: 'invalid_project_id' }, { status: 400 });
    }
    console.error('[runtime/ingest] error:', err);
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
