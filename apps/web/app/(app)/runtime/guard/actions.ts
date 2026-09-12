'use server';

import { revalidatePath } from 'next/cache';
import { getProject, getOrCreateRuntimeSecret, rotateRuntimeSecret } from '@scanlyfix/db';
import { requireUser } from '../../../../lib/authz.ts';
import { syncGuardRoutesToProber } from '../../../../lib/runtime/guard/sync.ts';

export type GuardActionResult =
  | { ok: true; syncedTargets: number }
  | { ok: false; error: string };

/** Refresh button — syncs discovered guard routes to prober targets. */
export async function refreshGuardAction(projectId: string): Promise<GuardActionResult> {
  try {
    const user = await requireUser();
    const project = await getProject(projectId, { kind: 'user', userId: user.id });
    if (!project) return { ok: false, error: 'not_found' };

    const { synced } = await syncGuardRoutesToProber(projectId);

    revalidatePath('/runtime/guard');
    revalidatePath('/runtime');
    revalidatePath('/runtime/probers');
    return { ok: true, syncedTargets: synced };
  } catch (err) {
    console.error('[refreshGuardAction] error:', err);
    return { ok: false, error: 'refresh_failed' };
  }
}

/** In dev/testing, allows seeding realistic route telemetry with 1 click. */
export async function simulateSampleTrafficAction(projectId: string): Promise<GuardActionResult> {
  try {
    const user = await requireUser();
    const project = await getProject(projectId, { kind: 'user', userId: user.id });
    if (!project) return { ok: false, error: 'not_found' };

    const { seedDemoGuardRoutes } = await import('@scanlyfix/db');
    await seedDemoGuardRoutes(projectId);

    revalidatePath('/runtime/guard');
    return { ok: true, syncedTargets: 8 };
  } catch (err) {
    console.error('[simulateSampleTrafficAction] error:', err);
    return { ok: false, error: 'simulate_failed' };
  }
}

export type ClearGuardRoutesResult =
  | { ok: true; deletedRoutes: number; deletedTargets: number }
  | { ok: false; error: string };

export async function clearGuardRoutesAction(
  projectId: string,
  confirmation?: string,
): Promise<ClearGuardRoutesResult> {
  try {
    const user = await requireUser();
    const project = await getProject(projectId, { kind: 'user', userId: user.id });
    if (!project) return { ok: false, error: 'not_found' };

    // Typed confirmation check: requires explicit confirmation token ('CLEAR' or project name)
    const normalized = confirmation?.trim();
    if (
      !normalized ||
      (normalized !== 'CLEAR' && normalized.toLowerCase() !== 'clear' && normalized !== project.name)
    ) {
      return { ok: false, error: 'confirmation_required' };
    }

    const { clearGuardRoutes } = await import('@scanlyfix/db');
    const result = await clearGuardRoutes(projectId);

    revalidatePath('/runtime/guard');
    revalidatePath('/runtime');
    revalidatePath('/runtime/probers');
    return {
      ok: true,
      deletedRoutes: result.deletedRoutes,
      deletedTargets: result.deletedTargets,
    };
  } catch (err) {
    console.error('[clearGuardRoutesAction] error:', err);
    return { ok: false, error: 'clear_failed' };
  }
}

/**
 * Returns (or lazily generates) the per-project Runtime signing secret.
 * Safe to call on every Guard setup card mount — idempotent, never rotates.
 */
export async function getOrCreateRuntimeSecretAction(
  projectId: string,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const viewer = { kind: 'user' as const, userId: user.id };
    const project = await getProject(projectId, viewer);
    if (!project) return { ok: false, error: 'not_found' };

    const secret = await getOrCreateRuntimeSecret(projectId);
    return { ok: true, secret };
  } catch (err) {
    console.error('[getOrCreateRuntimeSecretAction] error:', err);
    return { ok: false, error: 'secret_fetch_failed' };
  }
}

/**
 * Rotates (regenerates) the Runtime signing secret.
 * After calling this, any running SDK using the old secret gets 401 until
 * the developer updates their env var and redeploys.
 */
export async function rotateRuntimeSecretAction(
  projectId: string,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const viewer = { kind: 'user' as const, userId: user.id };
    const newSecret = await rotateRuntimeSecret(projectId, viewer);
    if (!newSecret) return { ok: false, error: 'not_found' };

    return { ok: true, secret: newSecret };
  } catch (err) {
    console.error('[rotateRuntimeSecretAction] error:', err);
    return { ok: false, error: 'rotate_failed' };
  }
}
