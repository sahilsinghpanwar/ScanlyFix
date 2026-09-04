/**
 * Post-signin confirmation for a scan the visitor started before authenticating.
 *
 * The URL the visitor typed is in sessionStorage (stashed by useScanSubmit on
 * the way to /login). This page shows the address back, warns that the report
 * is locked to it, and starts the scan only once the visitor confirms — the
 * scan then runs in the background, and the visitor lands on the dashboard,
 * which shows the loader and then the report. A scan that is not prioritised
 * bounces to /welcome?next=/dashboard for the one priority question on the
 * way.
 *
 * The full happy path is therefore: home page → type URL → press Scan →
 * sign in → /scan/start (confirm the address) → /scan/<id> running →
 * /welcome (if priorities are unset) → back to /scan/<id>. A visitor with
 * nothing pending is sent to the dashboard, where the scan form is the first
 * section on the page.
 */

import { StartScanClient } from './start-scan-client.tsx'

export const metadata = { title: 'Starting your scan' }

export default function StartScanPage() {
  return <StartScanClient />
}
