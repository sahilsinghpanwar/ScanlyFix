/**
 * Every tier, in one table.
 *
 * Nothing else in the codebase decides what a plan includes. A limit enforced
 * in one file and advertised from another is how a pricing page ends up
 * promising something the code refuses to do — which arrives as a refund
 * request rather than a bug report.
 *
 * ─── TESTING MODE ────────────────────────────────────────────────────────────
 * The free tier is currently configured to match Pro on every field. This is a
 * temporary state — every feature the paywall used to gate is now free so the
 * team can exercise the full product end-to-end without first going through
 * Razorpay. The structure below (separate `free` and `pro` records, separate
 * display strings, a `fixPrompts` boolean that still gates the aggregate prompt
 * server-side) is preserved intact so the previous behaviour is one revert
 * away: restore the historic values in the `free` block below and everything
 * else — the report, the dashboard, the API, the paywall — picks the change
 * up automatically.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * The free tier is deliberately generous about the SCAN and strict about the
 * REPORT. A free report has to be genuinely useful or nobody shares it, and
 * visibly incomplete or nobody upgrades. Showing every finding's severity and
 * title, and the three worst in full, does both: the reader knows exactly what
 * they are missing rather than being shown a blurred rectangle and asked to
 * guess.
 *
 * NOTE: `findingsShownInFull` is what a SIGNED-IN free account gets. A reader
 * with no account is not a plan and is not described here — see
 * lib/entitlements.ts, which resolves them to zero open findings while still
 * naming and rating every one.
 */

export type PlanId = 'free' | 'pro'

export interface Plan {
  id: PlanId
  name: string
  /**
   * DISPLAY ONLY. The amount actually charged is the one on the Razorpay Plan
   * named by `planIdEnv`, and this must be kept equal to it by hand — a
   * pricing page that disagrees with the checkout modal is a refund request,
   * not a bug report.
   */
  priceMonthly: number
  /** ISO 4217. Razorpay accounts are INR unless international payments are enabled. */
  currency: 'INR' | 'USD'
  /** null on free: nobody reaches the payment processor until they choose to. */
  planIdEnv: string | null

  scansPerMonth: number
  projects: number
  monitors: number

  /** Every finding in full, rather than the worst few. */
  fullFindings: boolean
  /** The aggregate fix prompt — the reason to pay. */
  fixPrompts: boolean
  history: boolean
  /** CSV / Markdown / PDF download of a scan. */
  exports: boolean
  /** Whether `/api/v1` answers this account at all. */
  apiAccess: boolean
  /**
   * How many keys the account may hold at once. Zero wherever `apiAccess` is
   * false, and that is not duplication — it is what makes the ceiling the only
   * thing the key-creation path has to check. A plan with access but no keys,
   * or keys but no access, is a bug the two fields cannot express separately
   * without one of them being ignored.
   */
  apiKeys: number

  /**
   * How many findings a plan without `fullFindings` sees in full. They are the
   * worst ones: the engine sorts worst-first, so a free reader always gets the
   * findings that matter most rather than whichever happened to be cheap.
   */
  findingsShownInFull: number
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  // TESTING MODE: every limit here is raised to match it. The previous values
  // are kept commented below so they can be restored in one edit.
  //   scansPerMonth:    30 → 500
  //   projects:          1 → 25
  //   monitors:          3 → 25
  //   fullFindings:  false → true
  //   fixPrompts:    false → true
  //   history:       false → true
  //   exports:       false → true
  //   apiAccess:     false → true
  //   apiKeys:           0 → 10
  //   findingsShownInFull: 3 → Infinity
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    currency: 'INR',
    planIdEnv: null,
    scansPerMonth: 500,
    projects: 25,
    monitors: 25,
    fullFindings: true,
    fixPrompts: true,
    history: true,
    exports: true,
    apiAccess: true,
    apiKeys: 10,
    findingsShownInFull: Number.POSITIVE_INFINITY,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 1499,
    currency: 'INR',
    planIdEnv: 'RAZORPAY_PLAN_PRO_MONTHLY',
    scansPerMonth: 500,
    projects: 25,
    monitors: 25,
    fullFindings: true,
    fixPrompts: true,
    history: true,
    exports: true,
    apiAccess: true,
    // Enough for CI, a staging pipeline and a laptop, with room to rotate one
    // without first revoking the one it replaces. Unbounded is not a feature:
    // keys nobody can account for are keys nobody revokes.
    apiKeys: 10,
    findingsShownInFull: Number.POSITIVE_INFINITY,
  },
}

/**
 * `subscriptions.plan` is free text — a processor's vocabulary changes and an
 * enum there would mean a migration every time pricing does. So an unrecognised
 * value resolves to free rather than throwing: a billing record we cannot read
 * must not take the product away from someone mid-session.
 */
export function planFor(plan: string | null | undefined): Plan {
  return plan === 'pro' ? PLANS.pro : PLANS.free
}

export const ORDERED_PLANS: readonly Plan[] = [PLANS.free, PLANS.pro]

/** "₹1,499" / "$19" — grouped, and never showing a trailing ".00". */
export function formatPrice(plan: Plan): string {
  return new Intl.NumberFormat(plan.currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: plan.currency,
    maximumFractionDigits: 0,
  }).format(plan.priceMonthly)
}
