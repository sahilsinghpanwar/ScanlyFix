'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { setCeilingAction, sendSampleAiCallAction } from '@/app/(app)/runtime/ai/actions.ts';
import { formatUsd, type AiSummary } from '@/lib/runtime/ai-log/summary.ts';

type Call = {
  id: string;
  provider?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number | null;
  costMicroUsd: number | null;
  userHash: string | null;
  createdAt: Date;
};

export function AiConsole(props: {
  projectId: string;
  summary: AiSummary;
  hourSpendMicroUsd: number;
  projectedHourMicroUsd: number;
  last24hMicroUsd: number;
  ceilingMicroUsd: number | null;
  calls: Call[];
}) {
  const { summary } = props;
  const [showSetup, setShowSetup] = useState(props.calls.length === 0);
  const pctOfCeiling =
    props.ceilingMicroUsd && props.ceilingMicroUsd > 0
      ? Math.min(100, Math.round((props.projectedHourMicroUsd / props.ceilingMicroUsd) * 100))
      : null;

  return (
    <div className="space-y-6">
      {/* ── SPEND HERO ── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <SpendCard
          label="This hour (live)"
          value={formatUsd(props.hourSpendMicroUsd)}
          sub={`Projection ${formatUsd(props.projectedHourMicroUsd)}/h${props.ceilingMicroUsd ? ` · Threshold ${formatUsd(props.ceilingMicroUsd)}` : ''}`}
          pct={pctOfCeiling}
          danger={pctOfCeiling !== null && pctOfCeiling >= 80}
        />
        <SpendCard
          label="Last 24 hours"
          value={formatUsd(props.last24hMicroUsd)}
          sub={`${summary.totalCalls} total calls (${summary.totalTokensIn + summary.totalTokensOut} tokens)`}
        />
        <SpendCard
          label="Top user share"
          value={summary.topUserSharePct !== null ? `${summary.topUserSharePct}%` : '—'}
          sub={summary.byUser[0] ? `${summary.byUser[0].userHash.slice(0, 10)}… (${summary.byUser[0].calls} calls)` : 'No user attribution yet'}
          danger={summary.topUserSharePct !== null && summary.topUserSharePct >= 80}
        />
      </div>

      <CeilingBar projectId={props.projectId} ceilingMicroUsd={props.ceilingMicroUsd} />

      {/* ── CALL LOG ── */}
      {props.calls.length === 0 ? (
        <SetupCard projectId={props.projectId} />
      ) : (
        <div className="space-y-6">
          <div className="overflow-hidden rounded-xl border border-c-line bg-c-card shadow-sm">
            <div className="flex flex-col gap-2 border-b border-c-line px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-c-ink">Recent AI Calls ({props.calls.length})</h3>
                <p className="text-xs text-c-muted">Latest calls observed via SDK wrappers — metadata only</p>
              </div>
              <button
                type="button"
                onClick={() => setShowSetup((v) => !v)}
                className="self-start rounded-lg border border-c-line bg-c-soft px-3 py-1.5 text-xs font-medium text-c-ink transition-colors hover:bg-c-line sm:self-auto"
              >
                {showSetup ? 'Hide Integration Snippets' : 'View Integration Snippets'}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-c-line bg-c-soft/60 text-xs uppercase tracking-wider text-c-muted">
                    <th className="px-4 py-2.5">Time</th>
                    <th className="px-4 py-2.5">Provider</th>
                    <th className="px-4 py-2.5">Model</th>
                    <th className="px-4 py-2.5">Tokens (In / Out)</th>
                    <th className="px-4 py-2.5">Latency</th>
                    <th className="px-4 py-2.5">Cost</th>
                    <th className="px-4 py-2.5">User Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-c-line">
                  {props.calls.map((c) => (
                    <tr key={c.id} className="transition-colors hover:bg-c-soft/40">
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-c-muted">
                        {new Date(c.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <span className="inline-flex items-center rounded bg-c-soft px-2 py-0.5 font-medium capitalize text-c-ink">
                          {c.provider || 'openai'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs font-medium text-c-ink">{c.model}</td>
                      <td className="px-4 py-2.5 text-xs text-c-ink">
                        {c.promptTokens.toLocaleString()} / {c.completionTokens.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-c-muted">{c.latencyMs !== null ? `${c.latencyMs}ms` : '—'}</td>
                      <td className="px-4 py-2.5 text-xs font-semibold text-c-ink">{formatUsd(c.costMicroUsd)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-c-muted">
                        {c.userHash ? `${c.userHash.slice(0, 10)}…` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {showSetup && <SetupCard projectId={props.projectId} hasCalls={props.calls.length > 0} />}
        </div>
      )}
    </div>
  );
}

function SpendCard({
  label,
  value,
  sub,
  pct,
  danger,
}: {
  label: string;
  value: string;
  sub?: string;
  pct?: number | null;
  danger?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-5 shadow-sm transition-colors ${
        danger ? 'border-red-500/40 bg-red-500/5' : 'border-c-line bg-c-card'
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-c-muted">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${danger ? 'text-red-600 dark:text-red-400' : 'text-c-ink'}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-c-muted">{sub}</p>}
      {pct !== null && pct !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded bg-c-soft">
          <div
            className={`h-full rounded transition-all ${danger ? 'bg-red-500' : 'bg-c-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function CeilingBar({ projectId, ceilingMicroUsd }: { projectId: string; ceilingMicroUsd: number | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function save(form: FormData) {
    const usd = Number(form.get('ceiling'));
    startTransition(async () => {
      const res = await setCeilingAction(projectId, usd);
      if (res.ok) {
        setMsg(`Threshold saved: $${usd}/hour`);
        router.refresh();
      } else {
        setMsg(res.error);
      }
    });
  }

  return (
    <div className="rounded-xl border border-c-line bg-c-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-semibold text-c-ink">Spend Alert Threshold:</p>
        <form action={save} className="flex items-center gap-2">
          <input
            name="ceiling"
            type="number"
            step="0.5"
            min="0.5"
            defaultValue={ceilingMicroUsd ? ceilingMicroUsd / 1e6 : 5}
            className="w-24 rounded-lg border border-c-line bg-c-soft px-2.5 py-1.5 text-sm text-c-ink shadow-sm focus:outline-none"
          />
          <span className="text-sm text-c-muted">USD / hour</span>
          <button
            disabled={pending}
            className="rounded-lg bg-c-accent px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Saving...' : 'Save'}
          </button>
        </form>
        {msg && <span className="text-xs font-medium text-c-muted">{msg}</span>}
      </div>
      <ul className="mt-3 space-y-1.5 border-t border-c-line pt-3 text-xs text-c-muted">
        <li className="flex items-center gap-2">
          <span className="text-emerald-500">✓</span>
          <span>
            <strong className="text-c-ink">Proactive spend protection:</strong> Wrapped calls refuse execution BEFORE reaching provider API if projected spend crosses the ceiling (SpendCeilingError).
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span className="text-emerald-500">✓</span>
          <span>
            <strong className="text-c-ink">Live velocity alerts:</strong> Inngest worker checks 15-minute windows and alerts if current spend velocity is projected to breach the threshold.
          </span>
        </li>
        <li className="flex items-center gap-2">
          <span className="text-c-muted">ℹ</span>
          <span>Metadata-only observation: prompt content and sensitive parameters never leave your infrastructure.</span>
        </li>
      </ul>
    </div>
  );
}

function SetupCard({ projectId, hasCalls = false }: { projectId: string; hasCalls?: boolean }) {
  const [tab, setTab] = useState<'openai' | 'anthropic'>('openai');
  const [origin, setOrigin] = useState('https://scanlyfix.com');
  const [sending, startTransition] = useTransition();
  const [sentMsg, setSentMsg] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  const handleSendTest = () => {
    setSentMsg(null);
    startTransition(async () => {
      const res = await sendSampleAiCallAction(projectId);
      if (res.ok) {
        setSentMsg('Test calls logged successfully!');
        router.refresh();
      } else {
        setSentMsg(`Error: ${res.error}`);
      }
    });
  };

  const openAiSnippet = `import { createRuntime, wrapOpenAI, SpendFirewall, MemorySpendStore } from '@scanlyfix/runtime-sdk';
import OpenAI from 'openai';

const runtime = createRuntime({
  projectId: process.env.RUNTIME_PROJECT_ID!,
  ingestUrl: process.env.RUNTIME_INGEST_URL ?? '${origin}/api/runtime/ingest',
});

// Optional hard spend firewall:
const firewall = new SpendFirewall({
  projectId: process.env.RUNTIME_PROJECT_ID!,
  store: new MemorySpendStore(), // Multi-instance? Use createUpstashStore(url, token)
  ceilingUsdPerHour: Number(process.env.RUNTIME_SPEND_CEILING_USD_PER_HOUR ?? 5),
});

export const openai = wrapOpenAI(new OpenAI(), {
  runtime,
  firewall,
  getUserId: () => session?.user?.id, // One-way hashed on your server — raw ID never transmitted
});`;

  const anthropicSnippet = `import { createRuntime, wrapAnthropic, SpendFirewall, MemorySpendStore } from '@scanlyfix/runtime-sdk';
import Anthropic from '@anthropic-ai/sdk';

const runtime = createRuntime({
  projectId: process.env.RUNTIME_PROJECT_ID!,
  ingestUrl: process.env.RUNTIME_INGEST_URL ?? '${origin}/api/runtime/ingest',
});

const firewall = new SpendFirewall({
  projectId: process.env.RUNTIME_PROJECT_ID!,
  store: new MemorySpendStore(),
  ceilingUsdPerHour: Number(process.env.RUNTIME_SPEND_CEILING_USD_PER_HOUR ?? 5),
});

export const anthropic = wrapAnthropic(new Anthropic(), {
  runtime,
  firewall,
  getUserId: () => session?.user?.id,
});`;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              {!hasCalls && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500"></span>
                </span>
              )}
              <h3 className="text-base font-semibold text-c-ink">
                {hasCalls ? 'SDK Integration Reference' : 'Awaiting First AI Call Telemetry'}
              </h3>
            </div>
            <p className="mt-1 text-sm text-c-muted">
              {hasCalls
                ? 'Copy these code snippets into additional services or functions to observe and protect AI calls.'
                : 'Attach the wrapper to your existing AI client in your application, or click "Send Test Event" to simulate calls and preview the live telemetry.'}
            </p>
          </div>

          {!hasCalls && (
            <div className="flex flex-col items-start sm:items-end gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleSendTest}
                disabled={sending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-c-accent px-4 py-2 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {sending ? 'Sending test...' : '⚡ Send Test Event'}
              </button>
              {sentMsg && <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{sentMsg}</span>}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => setTab('openai')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === 'openai'
                ? 'bg-c-accent text-white shadow-sm'
                : 'border border-c-line bg-c-card text-c-muted hover:text-c-ink'
            }`}
          >
            OpenAI
          </button>
          <button
            onClick={() => setTab('anthropic')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === 'anthropic'
                ? 'bg-c-accent text-white shadow-sm'
                : 'border border-c-line bg-c-card text-c-muted hover:text-c-ink'
            }`}
          >
            Anthropic
          </button>
        </div>

        <pre className="mt-3 overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3.5 font-mono text-xs text-c-ink">
          {tab === 'openai' ? openAiSnippet : anthropicSnippet}
        </pre>

        <pre className="mt-2 overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">{`RUNTIME_PROJECT_ID=${projectId}
RUNTIME_INGEST_URL=${origin}/api/runtime/ingest
RUNTIME_SPEND_CEILING_USD_PER_HOUR=5`}</pre>
      </div>

      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-c-ink">How AI Spend Guard Works</h3>
        <ul className="mt-3 space-y-2 text-sm text-c-muted">
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            <span><strong className="text-c-ink">Zero-proxy architecture:</strong> Your secret keys stay in your container; calls route direct to OpenAI/Anthropic.</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            <span><strong className="text-c-ink">Fail-open safety:</strong> Network issues to telemetry endpoints will never block or fail your user-facing AI requests.</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            <span><strong className="text-c-ink">Streaming inspection:</strong> Chunks stream through untouched; token usage is captured from final stream events with try/finally safety.</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            <span><strong className="text-c-ink">Runaway loop detection:</strong> Per-user token attribution identifies which user or cron job is consuming &gt;80% of spend.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}