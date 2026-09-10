import { describe, expect, it, vi } from 'vitest';
import { evaluateVelocity } from '../lib/runtime/ai-spend/velocity.ts';
import { buildAiSummary, formatUsd, projectEndOfHourMicroUsd } from '../lib/runtime/ai-log/summary.ts';

// Mock DB queries for route testing
vi.mock('@scanlyfix/db', () => ({
  recordRouteEvents: vi.fn().mockResolvedValue(2),
  recordAiCallEvents: vi.fn().mockResolvedValue(2),
}));

describe('AI Spend Velocity evaluation', () => {
  it('returns projected hourly spend and alerts when exceeding threshold', () => {
    // 15 min window, $1.50 spent (1,500,000 micro-USD) -> $6.00/hour projected
    // ceiling is $5.00/hour (5,000,000 micro-USD) -> 120% of ceiling -> shouldAlert: true
    const verdict = evaluateVelocity({
      windowMicroUsd: 1_500_000,
      windowMinutes: 15,
      ceilingMicroUsd: 5_000_000,
      alertAtPctOfCeiling: 80,
    });

    expect(verdict.projectedHourlyMicroUsd).toBe(6_000_000);
    expect(verdict.pctOfCeiling).toBe(120);
    expect(verdict.shouldAlert).toBe(true);
  });

  it('does not alert when projected spend is below threshold', () => {
    // 15 min window, $0.50 spent -> $2.00/hour projected
    // ceiling is $10.00/hour -> 20% of ceiling -> shouldAlert: false
    const verdict = evaluateVelocity({
      windowMicroUsd: 500_000,
      windowMinutes: 15,
      ceilingMicroUsd: 10_000_000,
    });

    expect(verdict.projectedHourlyMicroUsd).toBe(2_000_000);
    expect(verdict.pctOfCeiling).toBe(20);
    expect(verdict.shouldAlert).toBe(false);
  });

  it('handles zero or null ceiling safely', () => {
    const verdict = evaluateVelocity({
      windowMicroUsd: 500_000,
      windowMinutes: 15,
      ceilingMicroUsd: null,
    });

    expect(verdict.projectedHourlyMicroUsd).toBe(2_000_000);
    expect(verdict.pctOfCeiling).toBeNull();
    expect(verdict.shouldAlert).toBe(false);
  });
});

describe('AI Log Summary and Formatting', () => {
  it('formats micro-USD values accurately', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(45)).toBe('$0.0000'); // 4 decimals for sub-cent
    expect(formatUsd(5000)).toBe('$0.0050');
    expect(formatUsd(1_500_000)).toBe('$1.50');
    expect(formatUsd(25_750_000)).toBe('$25.75');
  });

  it('projects end of hour spend based on elapsed minutes', () => {
    const fixedTime = new Date('2026-03-01T10:30:00Z'); // 30 mins elapsed
    // $1.00 in 30 mins -> projected $2.00 at end of hour
    const projected = projectEndOfHourMicroUsd(1_000_000, fixedTime);
    expect(projected).toBe(2_000_000);
  });

  it('builds summary and detects runaway loop (single user >80% share)', () => {
    const calls = [
      {
        model: 'gpt-4o-mini',
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 300,
        costMicroUsd: 45,
        userHash: 'user-a',
        createdAt: new Date(),
      },
      {
        model: 'gpt-4o',
        promptTokens: 1000,
        completionTokens: 500,
        latencyMs: 1200,
        costMicroUsd: 7500,
        userHash: 'user-b',
        createdAt: new Date(),
      },
    ];

    const byModel = [
      { model: 'gpt-4o', calls: 1, costMicroUsd: 7500 },
      { model: 'gpt-4o-mini', calls: 1, costMicroUsd: 45 },
    ];

    const byUser = [
      { userHash: 'user-b', calls: 1, costMicroUsd: 7500 },
      { userHash: 'user-a', calls: 1, costMicroUsd: 45 },
    ];

    const summary = buildAiSummary({ calls, byModel, byUser });

    expect(summary.totalCalls).toBe(2);
    expect(summary.totalCostMicroUsd).toBe(7545);
    expect(summary.totalTokensIn).toBe(1100);
    expect(summary.totalTokensOut).toBe(550);
    // user-b had 7500 / 7545 = ~99% of total spend -> runaway loop signal
    expect(summary.topUserSharePct).toBeGreaterThanOrEqual(90);
  });
});

describe('Runtime Ingest Route with AI events', () => {
  it('processes and validates mixed route and ai_call events', async () => {
    const { POST } = await import('../app/api/runtime/ingest/route.ts');
    const { recordRouteEvents, recordAiCallEvents } = await import('@scanlyfix/db');

    const req = new Request('http://localhost:3000/api/runtime/ingest?projectId=proj-123', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { pattern: '/api/checkout', method: 'POST', hasSession: true },
          {
            type: 'ai_call',
            provider: 'openai',
            model: 'gpt-4o-mini',
            promptTokens: 100,
            completionTokens: 50,
            latencyMs: 250,
            userHash: 'user_hash_123',
          },
        ],
      }),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    expect(recordRouteEvents).toHaveBeenCalledWith('proj-123', [
      { pattern: '/api/checkout', method: 'POST', kind: undefined, hasSession: true },
    ]);

    expect(recordAiCallEvents).toHaveBeenCalledWith('proj-123', [
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 250,
        costMicroUsd: 45, // Server-calculated cost!
        userHash: 'user_hash_123',
      }),
    ]);
  });

  it('rejects missing projectId', async () => {
    const { POST } = await import('../app/api/runtime/ingest/route.ts');
    const req = new Request('http://localhost:3000/api/runtime/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('missing_project_id');
  });
});
