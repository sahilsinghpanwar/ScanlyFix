import Link from 'next/link'
import { Section, SectionHeading } from './section.tsx'
import { ORDERED_PLANS, formatPrice, type Plan } from '@/lib/plans.ts'
import { TOTAL_CHECKS } from '@/lib/pillars.ts'

/**
 * Pricing, rendered from plans.ts — the same table the entitlement code reads.
 *
 * A marketing page that can disagree with the code enforcing the limits is a
 * refund request waiting to be filed, so nothing here is a hand-written list.
 * The upgrade button itself is deliberately absent: it is a client component
 * that talks to the payment processor, and putting it here would pull the
 * checkout script into the landing page's budget for a click almost nobody
 * makes on this screen.
 */

function features(plan: Plan): string[] {
  return [
    `${plan.scansPerMonth} scans a month`,
    plan.fullFindings ? 'Every finding in full' : `The ${plan.findingsShownInFull} worst findings in full`,
    plan.fixPrompts ? 'One prompt that fixes the whole site' : 'Per-finding fix prompts',
    plan.history ? 'Scan history and score changes' : 'Latest scan only',
    plan.monitors > 0 ? `${plan.monitors} monitored sites` : 'No monitoring',
    `${plan.projects} ${plan.projects === 1 ? 'project' : 'projects'}`,
  ]
}

export function PlansPreview() {
  return (
    <Section id="pricing">
      <SectionHeading
        index={7}
        eyebrow="Pricing"
        title="Every plan runs every check"
        lead={`All ${TOTAL_CHECKS} checks run on every scan, free or paid. Pro is on the menu — the free tier currently matches it while we run end-to-end testing.`}
      />

      <div className="mt-12 grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2">
        {ORDERED_PLANS.map((plan) => (
          <div key={plan.id} className="flex min-w-0 flex-col bg-canvas p-6 sm:p-8">
            <div className="flex items-baseline gap-3">
              <h3 className="text-lg font-semibold tracking-tight">{plan.name}</h3>
              {plan.id === 'pro' && (
                <span className="bg-accent-soft px-2 py-0.5 font-mono text-xs uppercase tracking-[0.14em] link">
                  Everything
                </span>
              )}
            </div>

            <p className="mt-3 text-3xl font-semibold tabular-nums">
              {formatPrice(plan)}
              <span className="text-base font-normal text-muted"> / month</span>
            </p>

            <ul className="mt-6 flex flex-1 flex-col gap-3 text-[15px]">
              {features(plan).map((feature) => (
                <li key={feature} className="text-ink/70">
                  {feature}
                </li>
              ))}
            </ul>

            <Link
              href={plan.id === 'pro' ? '/settings/billing' : '/'}
              className={`mt-8 px-4 py-2.5 text-center text-[15px] font-medium transition-colors ${
 plan.id === 'pro'
                  ? 'bg-accent text-accent-ink hover:opacity-90'
                  : 'border border-line hover:bg-surface'
              }`}
            >
              {plan.id === 'pro' ? 'Manage subscription' : 'Start free'}
            </Link>
          </div>
        ))}
      </div>

      <p className="mt-6 max-w-[62ch] text-[15px] leading-relaxed text-ink/70 text-pretty">
        Every check runs on every plan. The free tier currently matches Pro on limits and reports —
        this is a temporary testing state and the difference returns when Pro is back on sale.
      </p>
    </Section>
  )
}
