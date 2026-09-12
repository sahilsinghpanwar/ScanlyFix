import { NextResponse } from 'next/server';

import { findCanaryByHoneytoken, getProjectOwnerEmail, getRuntimeProjectContext, insertCanaryEvents } from '@scanlyfix/db';

import { sendEmail } from '@/lib/email';
import { buildCanaryAlertEmail } from '@/lib/runtime/canaries/alert';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 🍯 HONEYTOKEN — decoy payload me yahi URL hota hai. Koi bhi isse hit kare
 * (GET/POST/anything) = usne database se extracted data USE kiya = exfiltration proof.
 * Response hamesha generic — attacker ko signal nahi ki ye honeypot hai.
 * No-cache zaroori — warna CDN ye endpoint cache karke hits miss karwa dega.
 */
async function handler(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  const canary = token ? await findCanaryByHoneytoken(token) : null;

  if (canary) {
    const detection = {
      kind: 'honeytoken_hit' as const,
      source: 'honeytoken' as const,
      canaryId: canary.id,
      detail: `Honeytoken ${token.slice(0, 6)}… hit (${req.method}) — extracted data in use`,
    };

    // 1) DB me log karo
    await insertCanaryEvents([{
      projectId: canary.projectId,
      canaryId: canary.id,
      kind: detection.kind,
      detail: detection.detail,
      source: detection.source,
    }]);

    // 2) Turant email — nightly wait nahi; honeytoken hit = critical, immediate action needed
    try {
      const [ownerEmail, ctx2] = await Promise.all([
        getProjectOwnerEmail(canary.projectId),
        getRuntimeProjectContext(canary.projectId),
      ]);
      if (ownerEmail) {
        const email = buildCanaryAlertEmail({
          hostname: ctx2?.hostname ?? canary.projectId,
          detections: [detection],
        });
        await sendEmail({ to: ownerEmail, ...email });
      }
    } catch {
      // Alert failure kabhi honeytoken response ko fail nahi karega
    }
  }

  // Hamesha generic 200 — hit ho ya na ho, koi difference attacker ko na dikhe
  return NextResponse.json(
    { status: 'received' },
    { headers: { 'cache-control': 'no-store, max-age=0' } },
  );
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;