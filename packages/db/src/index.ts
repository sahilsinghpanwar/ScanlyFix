/**
 * @scanlyfix/db — public surface.
 *
 * Consumers get the client, the schema (for types and for drizzle-kit), and
 * the query modules. They should never build SQL themselves: a query that
 * lives outside queries/ is a query nobody audited for who is allowed to run it.
 */

export { db, type Database } from './client.ts'
export * from './schema.ts'
export * from './queries/viewer.ts'
export * from './queries/scans.ts'
export * from './queries/dashboard.ts'
export * from './queries/users.ts'
export * from './queries/projects.ts'
export * from './queries/subscriptions.ts'
export * from './queries/monitors.ts'
export * from './queries/alerts.ts'
export * from './queries/alert-channels.ts'
export * from './queries/api-keys.ts'
export * from './queries/repo-scans.ts'
export * from './queries/github-installations.ts'
export * from './queries/connections.ts'
export * from './queries/rollups.ts'
export * from './queries/maintenance-windows.ts'
export * from './queries/incident-updates.ts'
export * from './queries/status-subscribers.ts'
export * from './queries/project-branding.ts'
export * from './queries/onboarding-defaults.ts'
export * from './maintenance-window.ts'
export { checkDns, diffDnsRecords } from './dns-checker.ts'
export type { DnsRecord, DnsCheckResult, DnsDiffResult } from './dns-checker.ts'
export * from './queries/runtime-prober.ts'
export * from './queries/runtime-guard.ts'
export * from './queries/runtime-ai.ts'
