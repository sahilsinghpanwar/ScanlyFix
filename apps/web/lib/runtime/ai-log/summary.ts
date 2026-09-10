/** PURE — DB ka kahin role nahi. UI + email dono yahi helpers use karein. */

export type CallRow = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number | null;
  costMicroUsd: number | null;
  userHash: string | null;
  createdAt: Date;
};

export function formatUsd(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return '—';
  if (microUsd === 0) return '$0.00';
  return `$${(microUsd / 1e6).toFixed(microUsd < 10_000 ? 4 : 2)}`; // <$0.01 → 4 decimals
}

/** Hour-ki-abhi-tak-ki rate se end-of-hour projection (0-div guard). */
export function projectEndOfHourMicroUsd(currentHourMicroUsd: number, now: Date = new Date()): number {
  const minutesElapsed = now.getUTCMinutes() + now.getUTCSeconds() / 60;
  if (minutesElapsed < 1) return currentHourMicroUsd;
  return Math.round((currentHourMicroUsd / minutesElapsed) * 60);
}

export type AiSummary = {
  totalCalls: number;
  totalCostMicroUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  byModel: Array<{ model: string; calls: number; costMicroUsd: number }>;
  byUser: Array<{ userHash: string; calls: number; costMicroUsd: number }>;
  /** ⭐ runaway-loop signal: 1 user > 80% spend */
  topUserSharePct: number | null;
};

export function buildAiSummary(input: {
  calls: CallRow[];
  byModel: Array<{ model: string; calls: number; costMicroUsd: number }>;
  byUser: Array<{ userHash: string | null; calls: number; costMicroUsd: number }>;
}): AiSummary {
  const totalCost = input.calls.reduce((s, c) => s + (c.costMicroUsd ?? 0), 0);
  const users = input.byUser.filter(
    (u): u is { userHash: string; calls: number; costMicroUsd: number } => u.userHash !== null,
  );
  const top = users[0];
  return {
    totalCalls: input.calls.length,
    totalCostMicroUsd: totalCost,
    totalTokensIn: input.calls.reduce((s, c) => s + c.promptTokens, 0),
    totalTokensOut: input.calls.reduce((s, c) => s + c.completionTokens, 0),
    byModel: input.byModel,
    byUser: users,
    topUserSharePct: top && totalCost > 0 ? Math.round((top.costMicroUsd / totalCost) * 100) : null,
  };
}