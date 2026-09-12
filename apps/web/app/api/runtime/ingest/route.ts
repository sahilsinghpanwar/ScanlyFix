import { NextResponse, type NextRequest } from 'next/server';
import {
  recordRouteEvents,
  recordAiCallEvents,
  getProjectRuntimeSecret,
  findProjectIdByHost,
  type IngestRouteEvent,
  type IngestAiCallEvent,
} from '@scanlyfix/db';
import { estimateCostMicroUsd } from '@scanlyfix/runtime-sdk';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';

/** Maximum events accepted per request. The SDK flushes ≤50; 100 is a hard cap. */
const MAX_EVENTS_PER_REQUEST = 100;

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

/**
 * Constant-time string equality — prevents timing-oracle attacks where an
 * attacker measures response latency to discover the secret one byte at a time.
 */
function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Run a dummy comparison of equal-length buffers so branch execution time
    // is constant regardless of length mismatch.
    const dummy = Buffer.alloc(b.length);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const rawProjectId =
      req.headers.get('x-runtime-project-id') ??
      url.searchParams.get('projectId');

    let projectId = rawProjectId?.trim();

    // ── Zero-Config Domain Auto-Detection ─────────────────────────────────────
    // If RUNTIME_PROJECT_ID was not manually set, automatically match the project
    // by the domain name of the incoming application traffic.
    if (!projectId) {
      const rawHost =
        req.headers.get('x-runtime-host') ??
        req.headers.get('x-forwarded-host') ??
        req.headers.get('origin') ??
        req.headers.get('referer') ??
        req.headers.get('host');

      if (rawHost) {
        const detectedId = await findProjectIdByHost(rawHost);
        if (detectedId) {
          projectId = detectedId;
        }
      }
    }

    if (!projectId) {
      return NextResponse.json(
        { ok: false, error: 'missing_project_id', hint: 'Specify RUNTIME_PROJECT_ID or send x-runtime-host' },
        { status: 400 },
      );
    }

    // ── Per-project signature validation ─────────────────────────────────────
    // Look up THIS project's signing secret from the DB. Each project has its
    // own secret — a leaked key for one project cannot forge events for another.
    //
    // If the project has no secret yet (null), the request is accepted so that
    // zero-config SDK setups work out of the box. Once a secret is generated
    // (by opening the Guard setup card), all further requests must carry it.
    const projectSecret = await getProjectRuntimeSecret(projectId);
    if (projectSecret) {
      const incoming = req.headers.get('x-runtime-signature') ?? '';
      if (!secretsEqual(incoming, projectSecret)) {
        return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as { events?: IngestPayloadEvent[] } | null;
    if (!body || !Array.isArray(body.events)) {
      return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
    }

    // ── Event count cap ───────────────────────────────────────────────────────
    // Prevents a malicious or misconfigured sender from triggering hundreds of
    // sequential DB writes in a single request. The SDK's maxBatchSize defaults
    // to 10–50; 100 is a generous hard ceiling.
    if (body.events.length > MAX_EVENTS_PER_REQUEST) {
      return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 400 });
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
