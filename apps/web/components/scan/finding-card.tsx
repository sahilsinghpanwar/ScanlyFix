/**
 * One finding.
 *
 * The evidence block is the point of this component. It is the difference
 * between "trust me" and "here is the header your server sent" — every claim
 * the engine makes is backed by a value it actually observed, and showing that
 * value is what makes the rest of the report believable.
 *
 * The `locked` variant exists before anything locks it (Phase 4). Retrofitting
 * a lock state into a card that assumes full data means touching every branch;
 * accepting it now costs one conditional.
 */

import type { Category, Severity } from '@scanlyfix/checks'
import { CopyButton } from './copy-button.tsx'
import { FixButton } from './fix-button.tsx'

export interface FindingView {
  checkId: string
  category: Category
  severity: Severity
  title: string
  description?: string | null
  evidence?: Record<string, unknown> | null
  remediation?: string | null
  fixPrompt?: string | null
  /** Free-tier placeholder: the server never sent the body of this finding. */
  locked?: boolean
}

/**
 * Two static strings per severity: a filled chip and the card's left stripe.
 * Static because Tailwind only emits classes it can read in the source — a
 * `bg-${severity}` template would be purged and the colour would vanish.
 */
const SEVERITY: Record<Severity, { chip: string; stripe: string }> = {
  critical: { chip: 'bg-critical text-canvas', stripe: 'border-l-critical' },
  high: { chip: 'bg-high text-canvas', stripe: 'border-l-high' },
  medium: { chip: 'bg-medium text-canvas', stripe: 'border-l-medium' },
  low: { chip: 'bg-low text-canvas', stripe: 'border-l-low' },
  info: { chip: 'bg-info text-canvas', stripe: 'border-l-info' },
}

function LockIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect x="5" y="11" width="14" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

/** The badge that marks a finding as Pro-only, with the lock. */
function ProBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 border border-accent bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider link">
      <LockIcon />
      Pro
    </span>
  )
}

/** Long enough to be evidence, short enough not to become the page. */
const MAX_VALUE_CHARS = 400

function renderValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (text === undefined) return 'undefined'
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
}

function Evidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence)
  if (entries.length === 0) return null

  return (
    <div className="mt-3">
      <p className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted">Observed</p>
      <dl className="overflow-x-auto border border-line bg-surface p-3 font-mono text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-col gap-0.5 py-1 sm:flex-row sm:gap-3">
            <dt className="shrink-0 text-muted sm:w-40">{key}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">{renderValue(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function FindingCard({
  finding,
  lockedNote = 'The detail and the fix for this finding are withheld.',
  scanId,
}: {
  finding: FindingView
  /** Why this one is closed. The card cannot know; the page can. */
  lockedNote?: string
  /**
   * The scan this finding belongs to. Present means the Fix button is live:
   * pressing it has the model write the work order for this exact finding.
   * Without it — a context with no scan to charge the fix to — the card keeps
   * the engine's static prompt instead.
   */
  scanId?: string
}) {
  const sev = SEVERITY[finding.severity]

  /*
   * A locked finding has nothing to read, so it does not get a card's worth of
   * space. It collapses to one dense row — severity, title, id, the Pro lock —
   * so a report with a dozen Pro items is scanned in a glance instead of
   * scrolled past a dozen "part of Pro" paragraphs. The open findings above it
   * keep their full cards, which is what makes the difference between "you can
   * read this" and "this is Pro" obvious without a word of explanation.
   */
  if (finding.locked) {
    return (
      <article
        title={lockedNote}
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 border border-line border-l-4 ${sev.stripe} bg-surface/60 px-4 py-2.5`}
      >
        <span
          className={`inline-flex items-center px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wider ${sev.chip}`}
        >
          {finding.severity}
        </span>
        <h3 className="min-w-0 flex-1 text-[15px] font-medium text-muted">{finding.title}</h3>
        <code className="hidden font-mono text-xs text-muted sm:block">{finding.checkId}</code>
        <ProBadge />
      </article>
    )
  }

  return (
    <details className={`group border border-line border-l-4 ${sev.stripe}`}>
      <summary className="cursor-pointer list-none px-5 py-4 transition-colors hover:bg-surface/60 [&::-webkit-details-marker]:hidden">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className={`inline-flex items-center px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wider ${sev.chip}`}
          >
            {finding.severity}
          </span>
          <h3 className="min-w-0 flex-1 text-lg font-semibold text-balance">{finding.title}</h3>
          <code className="hidden font-mono text-sm text-muted sm:block">{finding.checkId}</code>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="shrink-0 text-muted transition-transform group-open:rotate-180"
          >
            <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </summary>

      <div className="border-t border-line px-5 pb-5 pt-4">
        <code className="block font-mono text-sm text-muted sm:hidden">{finding.checkId}</code>

        {finding.description && (
          <p className="mt-2 max-w-[75ch] text-[15px] leading-relaxed text-muted text-pretty">{finding.description}</p>
        )}

        {finding.evidence && <Evidence evidence={finding.evidence} />}

        {finding.remediation && (
          <p className="mt-3 max-w-[75ch] text-[15px] leading-relaxed">
            <span className="font-medium">Fix: </span>
            {finding.remediation}
          </p>
        )}

        {scanId ? (
          <FixButton scanId={scanId} checkId={finding.checkId} />
        ) : (
          finding.fixPrompt && (
            <div className="mt-3">
              <CopyButton text={finding.fixPrompt} />
            </div>
          )
        )}
      </div>
    </details>
  )
}
