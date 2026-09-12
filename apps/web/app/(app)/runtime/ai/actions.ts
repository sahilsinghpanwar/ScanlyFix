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

export async function sendSampleAiCallAction(
  projectId: string,
  custom?: {
    model?: string;
    provider?: string;
    promptTokens?: number;
    completionTokens?: number;
  },
): Promise<AiActionResult> {
  try {
    const viewer = await getViewer();
    if (viewer.kind !== 'user') return { ok: false, error: 'unauthorized' };

    const projects = await listProjects(viewer);
    if (!projects.some((p) => p.id === projectId)) return { ok: false, error: 'not_found' };

    const hasAccess = await hasRuntimeAccess(viewer, projectId);
    if (!hasAccess) return { ok: false, error: 'upgrade_required' };

    const { estimateCostMicroUsd } = await import('@scanlyfix/runtime-sdk');

    if (custom?.model) {
      const model = custom.model;
      const provider = custom.provider || (model.startsWith('claude') ? 'anthropic' : 'openai');
      const promptTokens = Math.max(10, custom.promptTokens || Math.floor(Math.random() * 800) + 200);
      const completionTokens = Math.max(5, custom.completionTokens || Math.floor(Math.random() * 400) + 50);
      const latencyMs = Math.floor(Math.random() * 600) + 200;
      const costMicroUsd = estimateCostMicroUsd(model, promptTokens, completionTokens);

      await recordAiCallEvents(projectId, [
        {
          provider,
          model,
          promptTokens,
          completionTokens,
          latencyMs,
          costMicroUsd,
          userHash: 'usr_' + viewer.userId.slice(0, 8),
        },
      ]);
    } else {
      // Realistic simulation batch with dynamic token count & latency
      const p1 = Math.floor(Math.random() * 200) + 300;
      const c1 = Math.floor(Math.random() * 150) + 80;
      const p2 = Math.floor(Math.random() * 400) + 500;
      const c2 = Math.floor(Math.random() * 250) + 150;

      await recordAiCallEvents(projectId, [
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          promptTokens: p1,
          completionTokens: c1,
          latencyMs: Math.floor(Math.random() * 200) + 250,
          costMicroUsd: estimateCostMicroUsd('gpt-4o-mini', p1, c1),
          userHash: 'usr_' + viewer.userId.slice(0, 8),
        },
        {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          promptTokens: p2,
          completionTokens: c2,
          latencyMs: Math.floor(Math.random() * 400) + 600,
          costMicroUsd: estimateCostMicroUsd('claude-3-5-sonnet', p2, c2),
          userHash: 'usr_' + viewer.userId.slice(0, 8),
        },
      ]);
    }

    revalidatePath('/runtime/ai');
    revalidatePath('/runtime');
    return { ok: true };
  } catch {
    return { ok: false, error: 'sample_failed' };
  }
}