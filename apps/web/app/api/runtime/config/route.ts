import { NextResponse, type NextRequest } from 'next/server';
import {
  getProjectRuntimeSecret,
  getProjectRuntimeAuthSecrets,
  findProjectIdByHost,
  getSpendCeilingMicroUsd,
} from '@scanlyfix/db';
import { verifySignature, REPLAY_WINDOW_MS } from '@/lib/runtime/auth.ts';

export const runtime = 'nodejs';

/**
 * GET /api/runtime/config
 * HMAC-authenticated endpoint returning project runtime configuration.
 *
 * Response: { ok: true, ceilingUsdPerHour: number | null }
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const rawProjectId =
      req.headers.get('x-runtime-project-id') ??
      url.searchParams.get('projectId');

    let projectId = rawProjectId?.trim();

    // Zero-config host lookup hint
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

    // Per-project HMAC secret lookup (accepts current or prev within 24h grace)
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

    // Replay window enforcement
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

    // Constant-time signature verification over empty GET body
    const isValid = validSecrets.some((sec) =>
      verifySignature(incomingSignature, sec, '', timestampHeader),
    );
    if (!isValid) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const ceilingMicroUsd = await getSpendCeilingMicroUsd(projectId);
    const ceilingUsdPerHour =
      ceilingMicroUsd != null && ceilingMicroUsd > 0
        ? Math.round((ceilingMicroUsd / 1_000_000) * 100) / 100
        : null;

    return NextResponse.json({
      ok: true,
      ceilingUsdPerHour,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'internal_error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
