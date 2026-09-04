/**
 * Current plan, usage against it, and a way out.
 *
 * Deliberately thin, but less thin than it was. Stripe's billing portal used
 * to own cancellation, card changes, invoices and dunning; Razorpay has no
 * equivalent, so cancellation is here and the rest is where Razorpay puts it —
 * in the emails it sends the payer, which is where they will look anyway.
 */

import Link from 'next/link'
import { getSubscription } from '@scanlyfix/db'
import { requireUser } from '@/lib/authz.ts'
import { formatPrice, planFor } from '@/lib/plans.ts'
import { serverEnv } from '@/lib/env.ts'
import { BillingButton } from '@/components/billing/billing-button.tsx'

export const metadata = { title: 'Billing' }

function stamp(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export default async function BillingPage() {
  const user = await requireUser('/settings/billing')
  const subscription = await getSubscription(user.id)
  const plan = planFor(subscription?.plan)

  // Razorpay's vocabulary is wider than active/cancelled. `pending` means a
  // charge failed and it is retrying; `halted` means it has given up. Both are
  // "paid plan, something needs attention", and hiding that behind a green
  // tick is how a customer finds out by losing access.
  const needsAttention =
    subscription && !['created', 'active', 'authenticated', 'cancelled', 'completed'].includes(subscription.status)

  return (
    <>
      <h1 className="mt-8 text-2xl font-semibold tracking-[-0.02em]">Billing</h1>

      <section className="mt-8 border border-line p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-sm text-muted">Current plan</p>
            <p className="text-xl font-semibold">{plan.name}</p>
          </div>
          {plan.priceMonthly > 0 && (
            <p className="text-sm text-muted tabular-nums">{formatPrice(plan)} / month</p>
          )}
        </div>

        {needsAttention && (
          <p className="mt-4 border border-line bg-surface px-3 py-2 text-sm">
            Razorpay reports this subscription as <span className="font-mono">{subscription.status}</span>,
            which usually means a charge did not go through. Razorpay has emailed the payment
            method on file; resolve it there before access changes.
          </p>
        )}

        {subscription?.periodEnd && (
          <p className="mt-3 text-sm text-muted">
            {subscription.status === 'cancelled' ? 'Access ends' : 'Renews'} on{' '}
            {stamp(subscription.periodEnd)}.
          </p>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Scans a month</dt>
          <dd className="tabular-nums">{plan.scansPerMonth}</dd>
          <dt className="text-muted">Projects</dt>
          <dd className="tabular-nums">{plan.projects}</dd>
          <dt className="text-muted">Full findings</dt>
          <dd>{plan.fullFindings ? 'Yes' : `The ${plan.findingsShownInFull} worst`}</dd>
          <dt className="text-muted">Fix prompt</dt>
          <dd>{plan.fixPrompts ? 'Yes' : 'Per finding only'}</dd>
          <dt className="text-muted">API keys</dt>
          <dd className="tabular-nums">{plan.apiAccess ? plan.apiKeys : 'Not included'}</dd>
        </dl>

        {/*
         * TESTING MODE: free currently matches pro on every field, so the
         * "upgrade" button would offer nothing. Hidden until the limit split
         * returns; the page itself is unchanged.
         */}
        {plan.id === 'pro' && (
          <div className="mt-6 flex flex-wrap gap-3">
            {subscription?.status !== 'cancelled' && (
              <BillingButton action="cancel" label="Cancel subscription" variant="secondary" />
            )}
            <Link href="/pricing" className="self-center text-sm link">
              Compare plans
            </Link>
          </div>
        )}

        {!serverEnv.billingConfigured && (
          <p className="mt-4 text-sm text-muted">
            Billing is not configured on this deployment, so upgrading is unavailable.
          </p>
        )}
      </section>
    </>
  )
}
