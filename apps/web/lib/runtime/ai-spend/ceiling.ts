import { getSpendCeilingMicroUsd, setSpendCeiling } from '@scanlyfix/db'; // ⭐ ADAPT

const MICRO = 1_000_000;

export async function getCeilingUsd(projectId: string): Promise<number | null> {
  const micro = await getSpendCeilingMicroUsd(projectId);
  return micro === null ? null : micro / MICRO;
}

export async function updateCeilingUsd(projectId: string, usd: number): Promise<void> {
  await setSpendCeiling(projectId, Math.round(usd * MICRO));
}