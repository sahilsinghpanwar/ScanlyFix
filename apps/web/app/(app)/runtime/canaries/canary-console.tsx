'use client';

import { useState, useTransition } from 'react';

import {
  generateSetupScriptAction, runAnonAuditAction, runCanaryCheckAction,
} from './action';

type Canary = { marker: string; status: string; integrity: string | null; lastCheckedAt: string | null };
type Event = { id: string; kind: string; detail: string; source: string; detectedAt: string };
type AnonAuditResult = { readable: string[]; protectedCount: number };

const KIND_LABEL: Record<string, string> = {
  modified: 'Row modified', deleted: 'Row deleted', anon_readable: 'Anon-readable (RLS hole)',
  log_wiped: 'Log wiped (tamper)', honeytoken_hit: '🍯 Honeytoken hit', table_missing: 'Table missing',
};

export function CanaryConsole(props: {
  projectId: string; connected: boolean; planted: boolean; anonKeyConnected: boolean;
  canaries: Canary[]; events: Event[];
}) {
  const [pending, startTransition] = useTransition();
  const [sql, setSql] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [auditResult, setAuditResult] = useState<AnonAuditResult | null>(null);

  function gen() {
    startTransition(async () => {
      const r = await generateSetupScriptAction(props.projectId);
      if (r.ok && r.data) { setSql(r.data.sql); setMsg(null); }
      else if (!r.ok) setMsg(r.error);
    });
  }
  function verify() {
    startTransition(async () => {
      const res = await fetch('/api/runtime/supabase/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: props.projectId }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      setMsg(j.ok ? '✓ Setup verified — nightly checks active' : (j.error ?? 'verify failed'));
    });
  }
  function check() {
    startTransition(async () => {
      const r = await runCanaryCheckAction(props.projectId);
      setMsg(r.ok ? `Check done — ${r.data?.detections ?? 0} detections` : r.error);
    });
  }
  function runAudit() {
    startTransition(async () => {
      const r = await runAnonAuditAction(props.projectId);
      if (r.ok && r.data) setAuditResult(r.data);
      else if (!r.ok) setMsg(r.error);
    });
  }

  return (
    <div className="space-y-6">
      {/* ── SETUP FLOW ── */}
      {!props.planted && (
        <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-6">
          <h3 className="font-medium">{props.connected ? 'Step 2: Run the setup SQL' : 'Step 1: Connect Supabase'}</h3>
          <p className="text-sm text-muted-foreground">
            {!props.connected
              ? 'Supabase URL + service key do (encrypted store hoti hai) — form Overview/Runtime settings me. Service key se hum REST padhte hain; aapka app code kabhi touch nahi hota.'
              : 'Ye SQL Supabase Dashboard → SQL Editor me run karo. Ye ek vault table + watch triggers banata hai — tumhare apne tables me KUCH nahi likha jata, aur kuch block nahi hota — sirf log.'}
          </p>
          {props.connected && !sql && (
            <button onClick={gen} disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium disabled:opacity-50">
              Generate setup SQL
            </button>
          )}
          {sql && (
            <>
              <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">{sql}</pre>
              <div className="flex gap-2">
                <button onClick={verify} disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium disabled:opacity-50">
                  Verify setup
                </button>
                <button
                  onClick={() => { void navigator.clipboard.writeText(sql); setMsg('SQL copied'); }}
                  className="rounded-lg border px-4 py-2 text-sm font-medium"
                >
                  Copy SQL
                </button>
              </div>
            </>
          )}
          {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        </div>
      )}

      {/* ── CONTROLS ── */}
      {props.planted && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
          <button onClick={check} disabled={pending} className="rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-50">
            {pending ? 'Checking…' : 'Run check now'}
          </button>
          <button onClick={runAudit} disabled={pending || !props.anonKeyConnected} className="rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-50">
            Run anon-access audit
          </button>
          {!props.anonKeyConnected && (
            <span className="text-xs text-muted-foreground">RLS probe + audit ke liye anon key bhi connect karo</span>
          )}
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      )}

      {/* ── AUDIT REPORT ── */}
      {auditResult && (
        <div className={`rounded-xl border p-4 ${auditResult.readable.length > 0 ? 'border-destructive/40' : 'border-emerald-500/30'}`}>
          <h3 className="text-sm font-medium">Anon-access audit</h3>
          {auditResult.readable.length === 0 ? (
            <p className="mt-1 text-sm text-emerald-600">✓ Koi table anon key se readable nahi — RLS theek hai.</p>
          ) : (
            <div className="mt-2">
              <p className="text-sm text-destructive">🚨 Ye tables duniya ke liye readable hain (public anon key se):</p>
              <ul className="mt-1 list-inside list-disc font-mono text-xs">
                {auditResult.readable.map((t) => <li key={t}>{t}</li>)}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                {auditResult.protectedCount} tables protected · sirf names report hote hain, data kabhi nahi padha jata (count-only HEAD).
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── CANARY ROWS ── */}
      {props.canaries.length > 0 && (
        <div className="overflow-hidden rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">Marker</th><th className="px-4">Status</th>
                <th className="px-4">Integrity</th><th className="px-4">Last checked</th>
              </tr>
            </thead>
            <tbody>
              {props.canaries.map((c) => (
                <tr key={c.marker} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs">{c.marker}</td>
                  <td className="px-4">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${c.status === 'planted' ? 'bg-emerald-500/15 text-emerald-600' : c.status === 'compromised' ? 'bg-destructive/15 text-destructive' : 'bg-muted'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 text-xs">{c.integrity ?? '—'}</td>
                  <td className="px-4 text-xs text-muted-foreground">{c.lastCheckedAt ? new Date(c.lastCheckedAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── EVENTS TIMELINE ── */}
      <section className="space-y-2">
        <h2 className="font-medium">Events {props.events.length > 0 && <span className="text-destructive">({props.events.length})</span>}</h2>
        {props.events.length === 0 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
            <p className="text-sm font-medium text-emerald-600">✓ Koi canary touch nahi hui. Sab shaant hai.</p>
          </div>
        ) : (
          props.events.map((e) => (
            <div key={e.id} className="rounded-xl border border-destructive/40 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-destructive">{KIND_LABEL[e.kind] ?? e.kind}</p>
                <span className="text-xs text-muted-foreground">{new Date(e.detectedAt).toLocaleString()} · {e.source}</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{e.detail}</p>
            </div>
          ))
        )}
      </section>

      {/* ── HONESTY CARD ── */}
      <div className="rounded-xl border p-6">
        <h3 className="font-medium">What canaries can — and cannot — tell you</h3>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>✓ Writes (modify/delete): trigger-log se — deterministic, tamper-evident (log wipe bhi event hai).</li>
          <li>✓ Reads: Postgres SELECT triggers exist nahi karte — isliye hum WAIT nahi karte, hum khud anon key se read-test karte hain (RLS probe). Deterministic.</li>
          <li>✓ Exfiltration: honeytoken URLs — hit = extracted data in use, proof hai.</li>
          <li className="text-muted-foreground/70">✗ Jo hum nahi dekh sakte: kaun KIS user ne touch kiya (DB-level identity humare paas nahi hota), aur non-Supabase databases. Jahan nazar nahi, wahan claim nahi.</li>
        </ul>
      </div>
    </div>
  );
}