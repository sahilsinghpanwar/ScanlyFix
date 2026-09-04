/**
 * Findings, grouped by pillar.
 *
 * Within a pillar the engine's order is preserved exactly — it already sorts
 * worst-first and then by check id, and re-sorting here would let the web
 * report and the CLI disagree about the same scan.
 *
 * A pillar that was checked and came back clean gets a row saying so. Silence
 * would read as "not checked", which is the opposite of the truth and throws
 * away the most reassuring thing the report can say.
 *
 * The pillar headings are the same numbered rule the landing page uses for its
 * sections, so a reader who arrived from that page is reading the same grammar.
 */

import type { Category } from '@scanlyfix/checks'
import { LabeledRule } from '@/components/ui/labeled-rule.tsx'
import { FindingCard, type FindingView } from './finding-card.tsx'
import { describeRest, PILLAR_LABEL as LABEL, splitPillars } from './pillar-view.ts'

/** A tick, for a pillar that came back clean. */
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FindingsList({
  findings,
  priorities = null,
  lockedNote,
  scanId,
}: {
  findings: readonly FindingView[]
  /** Pillars this reader chose at onboarding; null when they never answered. */
  priorities?: readonly Category[] | null
  /** Passed straight through: only the page knows which gate applies. */
  lockedNote?: string
  /** Passed straight through to every card: turns on the live Fix button. */
  scanId?: string
}) {
  const { chosen, rest } = splitPillars(priorities)
  const setAside = findings.filter((f) => rest.includes(f.category))

  const pillarSection = (pillar: Category, index: number) => {
    const inPillar = findings.filter((f) => f.category === pillar)

    const clean = inPillar.length === 0

    return (
      <section key={pillar} aria-labelledby={`pillar-${pillar}`}>
        <LabeledRule
          as="h2"
          id={`pillar-${pillar}`}
          index={index + 1}
          label={LABEL[pillar]}
          trailing={
            clean ? (
              <span className="inline-flex items-center gap-1 text-good">
                <CheckIcon /> clean
              </span>
            ) : (
              `${inPillar.length} found`
            )
          }
        />

        {clean ? (
          <p className="mt-4 flex items-center gap-2 border border-good/30 bg-good/5 px-4 py-3 text-[15px] text-good">
            <CheckIcon />
            Every {LABEL[pillar].toLowerCase()} check passed.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {inPillar.map((finding, i) => (
              <FindingCard
                key={`${finding.checkId}-${i}`}
                finding={finding}
                {...(lockedNote ? { lockedNote } : {})}
                {...(scanId ? { scanId } : {})}
              />
            ))}
          </div>
        )}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-12">
      {chosen.map(pillarSection)}

      {rest.length > 0 && (
        /*
         * <details> rather than a client component: it is one open/close with
         * no state to share, and the browser gives keyboard support, the right
         * ARIA and search-in-page for free. This whole report otherwise ships
         * no JavaScript.
         */
        <details className="border border-line">
          <summary className="cursor-pointer px-5 py-4 hover:bg-surface">
            <span className="label text-ink">The rest of the scan</span>
            <span className="mt-1 block text-[15px] text-muted text-pretty">
              {describeRest(rest, setAside)}
            </span>
          </summary>

          <div className="flex flex-col gap-12 border-t border-line px-5 py-8">
            {rest.map((pillar, index) => pillarSection(pillar, chosen.length + index))}
          </div>
        </details>
      )}
    </div>
  )
}

