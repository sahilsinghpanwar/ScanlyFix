'use server';

import { revalidatePath } from 'next/cache';

import { getProject, listCanaries, markCanariesSetup } from '@scanlyfix/db';

import { requireUser } from '@/lib/authz';
import { runAnonAccessAudit, runCanaryCheck } from '@/lib/runtime/canaries/engine';
import { buildSetupScript } from '@/lib/runtime/canaries/setup-script';

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

async function assertOwn(projectId: string): Promise<void> {
  const user = await requireUser();
  const project = await getProject(projectId, { kind: 'user', userId: user.id });
  if (!project) throw new Error('not_found');
}

/** Setup script generate — naye canary rows + markers humare DB me register hote hain. */
export async function generateSetupScriptAction(projectId: string): Promise<ActionResult<{ sql: string }>> {
  try {
    await assertOwn(projectId);
    const canaries = await listCanaries(projectId);
    if (canaries.length > 0 && canaries.every((c) => c.status !== 'pending_script')) {
      return { ok: false, error: 'canaries already planted — regenerate se pehle disconnect karo' };
    }
    const appDomain = process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, '') ?? 'localhost:3000';
    const { sql } = buildSetupScript({ projectId, appDomain });
    return { ok: true, data: { sql } };
  } catch {
    return { ok: false, error: 'generate_failed' };
  }
}

export async function runCanaryCheckAction(projectId: string): Promise<ActionResult<{ detections: number }>> {
  try {
    await assertOwn(projectId);
    const summary = await runCanaryCheck(projectId);
    revalidatePath('/runtime/canaries');
    return { ok: true, data: { detections: summary.detections.length } };
  } catch {
    return { ok: false, error: 'check_failed' };
  }
}

export async function runAnonAuditAction(projectId: string): Promise<ActionResult<{ readable: string[]; protectedCount: number }>> {
  try {
    await assertOwn(projectId);
    const report = await runAnonAccessAudit(projectId);
    if (!report) return { ok: false, error: 'anon key connect nahi hai' };
    revalidatePath('/runtime/canaries');
    return { ok: true, data: report };
  } catch {
    return { ok: false, error: 'audit_failed' };
  }
}