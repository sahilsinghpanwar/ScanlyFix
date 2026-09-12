import { NextResponse, type NextRequest } from 'next/server';
import {
  recordRouteEvents,
  recordAiCallEvents,
  getProjectRuntimeSecret,
  getProjectRuntimeAuthSecrets,
  findProjectIdByHost,
  type IngestRouteEvent,
  type IngestAiCallEvent,
} from '@scanlyfix/db';
import {
  estimateServerCostMicroUsd,
  getCachedModelCatalog,
} from '@/lib/runtime/ai-pricing/server-pricing.ts';
import {
  REPLAY_WINDOW_MS,
  secretsEqual,
  verifySignature,
} from '@/lib/runtime/auth.ts';

export const runtime = 'nodejs';

/** Maximum events accepted per request. The SDK flushes ≤50; 100 is a hard cap. */
const MAX_EVENTS_PER_REQUEST = 100;

/** Maximum request body size accepted (256 KB). Prevents memory exhaustion attacks. */
const MAX_BODY_BYTES = 256 * 1024;

/** Route pattern must be a valid URI path starting with / and up to 256 characters. */
const ROUTE_PATTERN_REGEX = /^\/[a-zA-Z0-9_\-./:[\]*~]{0,255}$/;

/** Allowed HTTP methods for route observation. */
const ALLOWED_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Allowed characters for model and provider identifiers. */
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_.:/-]{1,128}$/;

/** Allowed characters for hashed user attribution. */
const USER_HASH_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Upper sanity bound for token counts per call (10 million tokens). */
const MAX_SAFE_TOKENS = 10_000_000;

/** Upper sanity bound for call latency (1 hour = 3,600,000 ms). */
const MAX_SAFE_LATENCY_MS = 3_600_000;

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
    // ── Body Size Pre-check (Content-Length) ──────────────────────────────────
    const contentLengthHeader = req.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
        return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
      }
    }

    // ── Read Raw Body with Size Cap ──────────────────────────────────────────
    const rawBody = await req.text().catch(() => '');
    if (rawBody.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 413 });
    }

    const url = new URL(req.url);
    const rawProjectId =
      req.headers.get('x-runtime-project-id') ??
      url.searchParams.get('projectId');

    let projectId = rawProjectId?.trim();

    // ── Zero-Config Domain Auto-Detection (Lookup Hint ONLY) ───────────────────
    // If RUNTIME_PROJECT_ID was not explicitly provided, look up which project
    // this host might belong to. Note: host matching is strictly a lookup hint.
    // It grants NO access without a valid signature matching that project's secret.
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

    // ── Per-Project Signature & Authentication ────────────────────────────────
    // The HMAC signature / secret is the SOLE authentication factor.
    // Every project MUST have a signing secret configured.
    // Ingest accepts EITHER secret (current or prev) within 24h after rotation.
    const { validSecrets } = await getProjectRuntimeAuthSecrets(projectId);
    if (validSecrets.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized', hint: 'Project has no runtime signing secret configured' },
        { status: 401 },
      );
    }

    const incomingSignature = req.headers.get('x-runtime-signature');
    if (!incomingSignature) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized', hint: 'Missing x-runtime-signature header' },
        { status: 401 },
      );
    }

    // ── Replay Window Enforcement ────────────────────────────────────────────
    const timestampHeader = req.headers.get('x-runtime-timestamp');
    if (timestampHeader) {
      const ts = Number(timestampHeader);
      if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
        return NextResponse.json(
          { ok: false, error: 'unauthorized', hint: 'Timestamp outside replay window' },
          { status: 401 },
        );
      }
    }

    // Constant-time signature verification against any valid secret (current or 24h grace prev)
    const isValid = validSecrets.some((sec) =>
      verifySignature(incomingSignature, sec, rawBody, timestampHeader),
    );
    if (!isValid) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // ── Parse JSON Payload ───────────────────────────────────────────────────
    let body: { events?: IngestPayloadEvent[] } | null = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
    }

    if (!body || !Array.isArray(body.events)) {
      return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
    }

    // ── Event Count Cap ───────────────────────────────────────────────────────
    if (body.events.length > MAX_EVENTS_PER_REQUEST) {
      return NextResponse.json({ ok: false, error: 'payload_too_large' }, { status: 400 });
    }

    if (body.events.length === 0) {
      return NextResponse.json({
        ok: true,
        recorded: 0,
        recordedRoutes: 0,
        recordedAi: 0,
      });
    }

    const routeEvents: IngestRouteEvent[] = [];
    const aiEvents: IngestAiCallEvent[] = [];
    const modelCatalog = await getCachedModelCatalog();

    for (const ev of body.events) {
      if (!ev || typeof ev !== 'object') continue;

      if (ev.type === 'ai_call') {
        const rawPrompt = ev.promptTokens;
        const rawCompletion = ev.completionTokens;
        const rawLatency = ev.latencyMs;

        // Strict safe integer bounds validation
        const promptTokens =
          typeof rawPrompt === 'number' && Number.isSafeInteger(rawPrompt) && rawPrompt >= 0
            ? Math.min(rawPrompt, MAX_SAFE_TOKENS)
            : 0;

        const completionTokens =
          typeof rawCompletion === 'number' && Number.isSafeInteger(rawCompletion) && rawCompletion >= 0
            ? Math.min(rawCompletion, MAX_SAFE_TOKENS)
            : 0;

        const latencyMs =
          typeof rawLatency === 'number' && Number.isSafeInteger(rawLatency) && rawLatency >= 0
            ? Math.min(rawLatency, MAX_SAFE_LATENCY_MS)
            : 0;

        const rawModel = String(ev.model ?? '').trim();
        const model = SAFE_IDENTIFIER_REGEX.test(rawModel) ? rawModel : 'unknown';

        const rawProvider = String(ev.provider ?? '').trim();
        const provider = SAFE_IDENTIFIER_REGEX.test(rawProvider) ? rawProvider : 'unknown';

        // Server recalculates cost using tiered pricing: Curated -> LiteLLM catalog -> Fallback
        const costMicroUsd = await estimateServerCostMicroUsd(
          model,
          promptTokens,
          completionTokens,
          modelCatalog,
        );

        let userHash: string | null = null;
        if (typeof ev.userHash === 'string') {
          const trimmed = ev.userHash.trim().slice(0, 64);
          if (USER_HASH_REGEX.test(trimmed)) {
            userHash = trimmed;
          }
        }

        aiEvents.push({
          provider,
          model,
          promptTokens,
          completionTokens,
          latencyMs,
          costMicroUsd,
          userHash,
        });
      } else if ('pattern' in ev && 'method' in ev) {
        const routeEv = ev as IngestRouteEvent;
        const rawPattern = String(routeEv.pattern ?? '').trim();
        const rawMethod = String(routeEv.method ?? '').trim().toUpperCase();

        // Validate pattern matches safe URL path regex & method is standard HTTP verb
        if (ROUTE_PATTERN_REGEX.test(rawPattern) && ALLOWED_HTTP_METHODS.has(rawMethod)) {
          const rawKind = routeEv.kind ? String(routeEv.kind).trim().slice(0, 32) : undefined;
          routeEvents.push({
            pattern: rawPattern,
            method: rawMethod,
            kind: rawKind && /^[a-zA-Z0-9_-]{1,32}$/.test(rawKind) ? rawKind : undefined,
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
