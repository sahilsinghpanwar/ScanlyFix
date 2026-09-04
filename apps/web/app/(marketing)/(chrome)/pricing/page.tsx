/**
 * Rendered from plans.ts, never from a hand-written list.
 *
 * A pricing page that can disagree with the code enforcing the limits is a
 * refund request waiting to be filed — the customer read one number and the
 * product applied another, and they are not wrong.
 */

import Link from 'next/link'
import { allChecks } from '@scanlyfix/checks'
import { ORDERED_PLANS, formatPrice, type Plan } from '@/lib/plans.ts'

export const metadata = {
  title: 'Pricing',
  description: 'Every plan runs every check. Pro is for when you want to be paying for it.',
}

function features(plan: Plan): string[] {
  return [
    `${plan.scansPerMonth} scans a month`,
    `${plan.projects} ${plan.projects === 1 ? 'project' : 'projects'}`,
    plan.fullFindings ? 'Every finding in full' : `The ${plan.findingsShownInFull} worst findings in full`,
    plan.fixPrompts ? 'One prompt that fixes the whole site' : 'Per-finding fix prompts',
    plan.history ? 'Scan history and score changes' : 'Latest scan only',
    plan.monitors > 0 ? `${plan.monitors} monitored sites` : 'No monitoring',
    // Advertised only now that /api/v1 answers. plans.ts holds the boolean
    // precisely so this line and the code that enforces it cannot disagree.
    plan.apiAccess ? `API access · ${plan.apiKeys} keys` : 'No API access',
  ]
}

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
      <p className="mt-3 max-w-[60ch] text-muted text-pretty">
        Every scan runs all {allChecks.length} checks, on every plan. What differs is how much of the
        report you get back.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {ORDERED_PLANS.map((plan) => (
          <section
            key={plan.id}
            className={` border p-6 ${plan.id === 'pro' ? 'border-accent' : 'border-line'}`}
          >
            <h2 className="font-medium">{plan.name}</h2>
            <p className="mt-2 text-3xl font-semibold tabular-nums">
              {formatPrice(plan)}
              <span className="text-base font-normal text-muted"> / month</span>
            </p>

            <ul className="mt-5 flex flex-col gap-2 text-sm">
              {features(plan).map((feature) => (
                <li key={feature} className="text-muted">
                  {feature}
                </li>
              ))}
            </ul>

            <div className="mt-6">
              {/*
               * TESTING MODE: free currently matches pro, so the upgrade
               * button would offer nothing. The pro card keeps the call to
               * action only if a Razorpay subscription is already in place —
               * managed from the billing settings page, not the marketing
               * pricing page.
               */}
              <Link href="/" className="text-sm link">
                Run a free scan
              </Link>
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 text-sm text-muted">
        Cancel any time from the billing portal. Access continues to the end of the period you paid for.
      </p>
    </div>
  )
}
