import { NextResponse } from 'next/server';

import { findCanaryByHoneytoken, insertCanaryEvents } from '@scanlyfix/db'; // ⭐ ADAPT

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
    await insertCanaryEvents([
      {
        projectId: canary.projectId,
        canaryId: canary.id,
        kind: 'honeytoken_hit',
        detail: `Honeytoken ${token.slice(0, 6)}… hit (${req.method}) — extracted data in use`,
        source: 'honeytoken',
      },
    ]);
    // ⭐ Urgent — isko turant email karo (nightly wait nahi):
    // ADAPT: apne alert infra se direct email ya Inngest event fire karo:
    // await sendCanaryHoneytokenAlert(canary.projectId, token);
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