'use server';

import { revalidatePath } from 'next/cache';

import { getRuntimeProjectContext, resolveFindingManually, getProject, getProjectOwnerEmail } from '@scanlyfix/db';
import { requireUser } from '@/lib/authz';
import { runAuthProber } from '@/lib/runtime/auth-prober';
import { buildProberAlertEmail } from '@/lib/runtime/auth-prober/alert';
import { sendEmail } from '@/lib/email';

export type ActionResult =
  | {
      ok: true;
      message?: string;
      summary?: {
        checked: number;
        baselinesRecorded: number;
        newFindings: number;
        autoResolved: number;
        stillOpen: number;
        errors: number;
      };
    }
  | { ok: false; error: string };

async function assertOwnership(projectId: string): Promise<void> {
  const user = await requireUser();
  const project = await getProject(projectId, { kind: 'user', userId: user.id });
  if (!project) throw new Error('not_found');
}

/** "Record the baseline" / "Refresh" — dono isi se. */
export async function runProberAction(projectId: string): Promise<ActionResult> {
  try {
    await assertOwnership(projectId);
    const ctx = await getRuntimeProjectContext(projectId);
    if (!ctx?.isVerified) return { ok: false, error: 'verify_domain_first' };

    const summary = await runAuthProber(projectId, {
      onNewFindings: async (findings) => {
        const ownerEmail = await getProjectOwnerEmail(projectId);
        if (!ownerEmail) return;
        const email = buildProberAlertEmail({ projectUrl: ctx.hostname, findings });
        await sendEmail({ to: ownerEmail, ...email });
      },
    });
    revalidatePath(`/runtime`);
    revalidatePath(`/runtime/probers`);
    return {
      ok: true,
      summary: {
        checked: summary.checked,
        baselinesRecorded: summary.baselinesRecorded,
        newFindings: summary.newFindings,
        autoResolved: summary.autoResolved,
        stillOpen: summary.stillOpen,
        errors: summary.errors,
      },
      message:
        summary.baselinesRecorded > 0
          ? `Recorded baselines for ${summary.baselinesRecorded} target(s).`
          : `Probed ${summary.checked} target(s) (${summary.newFindings} new regressions, ${summary.errors} errors).`,
    };
  } catch (err) {
    console.error('[runProberAction] error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'run_failed' };
  }
}

export async function addTargetAction(projectId: string, path: string): Promise<ActionResult> {
  try {
    await assertOwnership(projectId);
    const cleanPath = path.trim();
    if (!cleanPath || !cleanPath.startsWith('/')) {
      return { ok: false, error: 'Path must start with / (e.g. /admin, /api/secret)' };
    }
    const { addProberTarget } = await import('@scanlyfix/db');
    await addProberTarget(projectId, cleanPath, 'GET', 'manual');
    revalidatePath('/runtime');
    revalidatePath('/runtime/probers');
    return { ok: true, message: `Added ${cleanPath} to monitored targets.` };
  } catch (err) {
    console.error('[addTargetAction] error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'add_target_failed' };
  }
}

export async function deleteTargetAction(projectId: string, targetId: string): Promise<ActionResult> {
  try {
    await assertOwnership(projectId);
    const { deleteProberTarget } = await import('@scanlyfix/db');
    await deleteProberTarget(projectId, targetId);
    revalidatePath('/runtime');
    revalidatePath('/runtime/probers');
    return { ok: true, message: 'Target removed.' };
  } catch (err) {
    console.error('[deleteTargetAction] error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'delete_target_failed' };
  }
}

export async function resolveFindingAction(projectId: string, findingId: string): Promise<ActionResult> {
  try {
    await assertOwnership(projectId);
    await resolveFindingManually(findingId, projectId);
    revalidatePath(`/runtime`);
    revalidatePath(`/runtime/probers`);
    return { ok: true, message: 'Finding marked as resolved.' };
  } catch (err) {
    console.error('[resolveFindingAction] error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'resolve_failed' };
  }
}