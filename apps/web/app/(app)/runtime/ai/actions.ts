'use server';

import { revalidatePath } from 'next/cache';

import { getViewer } from '@/lib/authz.ts';
import { listProjects, recordAiCallEvents } from '@scanlyfix/db';
import { hasRuntimeAccess } from '@/lib/entitlements.ts';
import { updateCeilingUsd } from '@/lib/runtime/ai-spend/ceiling.ts';

export type AiActionResult = { ok: true } | { ok: false; error: string };

export async function setCeilingAction(projectId: string, ceilingUsd: number): Promise<AiActionResult> {
  try {
    const viewer = await getViewer();
    if (viewer.kind !== 'user') return { ok: false, error: 'unauthorized' };

    const projects = await listProjects(viewer);
    if (!projects.some((p) => p.id === projectId)) return { ok: false, error: 'not_found' };

    const hasAccess = await hasRuntimeAccess(viewer, projectId);
    if (!hasAccess) return { ok: false, error: 'upgrade_required' };

    if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0.5 || ceilingUsd > 10_000) {
      return { ok: false, error: 'ceiling must be $0.50–$10,000' };
    }

    await updateCeilingUsd(projectId, ceilingUsd);
    revalidatePath('/runtime/ai');
    revalidatePath('/runtime');
    return { ok: true };
  } catch {
    return { ok: false, error: 'save_failed' };
  }
}

export async function sendSampleAiCallAction(projectId: string): Promise<AiActionResult> {
  try {
    const viewer = await getViewer();
    if (viewer.kind !== 'user') return { ok: false, error: 'unauthorized' };

    const projects = await listProjects(viewer);
    if (!projects.some((p) => p.id === projectId)) return { ok: false, error: 'not_found' };

    const hasAccess = await hasRuntimeAccess(viewer, projectId);
    if (!hasAccess) return { ok: false, error: 'upgrade_required' };

    await recordAiCallEvents(projectId, [
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 420,
        completionTokens: 180,
        latencyMs: 320,
        costMicroUsd: 171, // (420 * 0.15) + (180 * 0.6) = 63 + 108 = 171 micro USD ($0.000171)
        userHash: 'usr_' + viewer.userId.slice(0, 8),
      },
      {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        promptTokens: 850,
        completionTokens: 320,
        latencyMs: 840,
        costMicroUsd: 7350, // (850 * 3.0) + (320 * 15.0) = 2550 + 4800 = 7350 micro USD ($0.00735)
        userHash: 'usr_' + viewer.userId.slice(0, 8),
      },
    ]);

    revalidatePath('/runtime/ai');
    revalidatePath('/runtime');
    return { ok: true };
  } catch {
    return { ok: false, error: 'sample_failed' };
  }
}