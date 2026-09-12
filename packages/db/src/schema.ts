/**
 * ScanlyFix database schema (Drizzle / Postgres).
 *
 * Design rule: this schema is a *projection of the engine's types*, not an
 * independent model. Every field `@scanlyfix/checks` produces — each `Finding`
 * property, each `ScanScores` pillar — has a column or a typed jsonb slot here.
 * If the two drift, a scan silently loses data between "computed" and "stored",
 * so the severity/category enums below are compile-time locked to the unions in
 * `packages/checks/src/types.ts`.
 *
 * Identity: `users.authSubject` mirrors the Supabase `auth.users.id` (a UUID).
 * Supabase Auth owns credentials; this table only carries the app-level row
 * everything else foreign-keys to.
 */

import type { Category, ScanScores, Severity } from '@scanlyfix/checks'
import type { RepoCategory, RepoScanScores } from '@scanlyfix/repo-checks'
import { desc, isNotNull, isNull, relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import type { MonitorEventDiff } from './types/monitor-diff.ts'

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fails to compile if a Postgres enum and its engine union stop matching in
 * *either* direction — a new `Severity` with no column value, or a column value
 * the engine can never emit. Both corrupt scoring, so catch it at build time.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low', 'info'] as const
const CATEGORY_VALUES = ['security', 'seo', 'aeo', 'performance', 'accessibility', 'compliance'] as const

export const _severityLocked: Exact<Severity, (typeof SEVERITY_VALUES)[number]> = true
export const _categoryLocked: Exact<Category, (typeof CATEGORY_VALUES)[number]> = true

export const severityEnum = pgEnum('severity', SEVERITY_VALUES)
export const categoryEnum = pgEnum('category', CATEGORY_VALUES)

/** Scan lifecycle. Mirrors the Inngest step sequence, so 'queued' — not 'pending'. */
export const scanStatusEnum = pgEnum('scan_status', ['queued', 'running', 'done', 'failed'])

/**
 * How deep a scan went. `fast` is HTTP-only and runs inline; `deep` adds the
 * headless browser, PageSpeed and a crawl, and runs on the queue.
 *
 * This is a comparability key, not a label. A deep scan surfaces findings a
 * fast scan cannot see, so its score is legitimately lower for an unchanged
 * site — charting the two on one line would show a drop that never happened.
 */
export const scanProfileEnum = pgEnum('scan_profile', ['fast', 'deep'])

/** User-controlled triage state; drives the "3 fixed, 1 new" re-scan diff. */
export const findingStatusEnum = pgEnum('finding_status', ['open', 'fixed', 'ignored'])

/** The four cron kinds that share the `monitors` table. */
export const monitorTypeEnum = pgEnum('monitor_type', ['uptime', 'rescan', 'domain', 'web_vitals'])

export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'member'])
export const alertChannelEnum = pgEnum('alert_channel', ['email', 'slack', 'webhook', 'discord'])
export const reportFormatEnum = pgEnum('report_format', ['pdf', 'md'])

/**
 * Repo-scan enums. These mirror the union the repo engine emits, the same way
 * severityEnum/categoryEnum mirror the site engine — and the compile-time lock
 * below catches a drift in EITHER direction so a stored repo finding can never
 * land under a pillar the engine never emits.
 */
const REPO_CATEGORY_VALUES = ['secrets', 'supply-chain', 'ci-cd', 'code-quality', 'dependencies', 'governance'] as const
export const _repoCategoryLocked: Exact<RepoCategory, (typeof REPO_CATEGORY_VALUES)[number]> = true

export const repoCategoryEnum = pgEnum('repo_category', REPO_CATEGORY_VALUES)
export const repoScanStatusEnum = pgEnum('repo_scan_status', ['queued', 'running', 'done', 'failed'])
export const repoScanProfileEnum = pgEnum('repo_scan_profile', ['shallow', 'deep'])
export const repoFindingStatusEnum = pgEnum('repo_finding_status', ['open', 'fixed', 'ignored'])


/* -------------------------------------------------------------------------- */
/* jsonb payload shapes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Storable summary of the `CheckContext` a scan ran against. jsonb rather than
 * columns because it is display/debug metadata, never a query predicate.
 * `framework` is the one field the product leans on: stack-aware fix prompts
 * are selected from it.
 */
export interface ScanContextMeta {
  finalUrl: string
  redirectChain: string[]
  status: number
  framework: string | null
  /**
   * Where the site is served from — Vercel, Netlify, Cloudflare, nginx.
   * Stored alongside `framework` because it is the field that decides where
   * response headers are configured, and for a header fix that matters more
   * than which framework rendered the page.
   */
  platform: string | null
  /** ISO-8601 — jsonb has no Date type, so it round-trips as a string. */
  tlsExpiry: string | null
}

/**
 * Storable summary of the RepoCheckContext a repo scan ran against. Same
 * discipline as ScanContextMeta: jsonb rather than columns because it is
 * display/debug metadata, never a query predicate.
 */
export interface RepoScanContextMeta {
  defaultBranch: string
  /** Detected framework/language mix, for stack-aware fix prompts. */
  framework: string | null
  /** Whether the scan cloned the repo (`deep`) or read the API only (`shallow`). */
  profile: 'shallow' | 'deep'
  /** Repo size in KiB as seen at scan time; null on a shallow scan that did not clone. */
  sizeKib: number | null
  /** The installation id the scan was authorised under — audit, not lookup. */
  installationId: number
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * App-level user row.
 *
 * `id` is the APPLICATION's own identifier and is generated here. It used to be
 * copied from the provider's user id, which made the primary key of six
 * tables a foreign vendor's identifier — and every later provider swap would
 * have meant migrating every one of them. `authSubject` carries the provider's
 * id instead, so the next swap is one column rather than a schema rewrite.
 *
 * No password or name columns. The identity provider owns credentials, and a
 * duplicated credential is a liability with no upside.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * The identity provider's stable id for this person — a Supabase UUID today.
   *
   * Unique, so two app rows can never claim one identity. Nullable only so the
   * column could be added to an existing table; every row written since carries
   * one, and getViewer refuses anyone it cannot match.
   *
   * Deliberately NOT the email. An email changes, and an account keyed on one
   * silently becomes a different account the day it does.
   */
  authSubject: text('auth_subject').unique(),
  email: text('email').notNull().unique(),
  /**
   * The pillars this person said they care about, asked once after their first
   * sign-in. Typed as the engine's own Category enum rather than free text, so
   * a pillar cannot be stored that no check will ever report on.
   *
   * NULL and [] mean different things and both are load-bearing:
   *   null  — never asked. This is what sends someone to /welcome.
   *   [...] — asked and answered. "All of it" stores every category, so the
   *           report logic stays one rule instead of a special case.
   */
  priorities: categoryEnum('priorities').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Team container for the top tier. Present from day one so adding teams later is not a migration of every FK. */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Composite PK: a user belongs to an org at most once, enforced by the DB
  // rather than by application code a concurrent insert can slip past.
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index('memberships_user_idx').on(t.userId)],
)

/* -------------------------------------------------------------------------- */
/* Projects                                                                   */
/* -------------------------------------------------------------------------- */

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for personal projects; set once the project moves into a team. */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /** Public handle for /status/[slug] — never put the UUID in a shareable URL. */
    slug: text('slug').notNull().unique(),
    /** "nextjs" | "vite" | … — cached detection that picks the fix-prompt template variant. */
    frameworkHint: text('framework_hint'),
    /**
     * Ownership proof (DNS TXT / meta tag / file). This flag is the gate for
     * anything active: passive checks run against any URL, intrusive ones only
     * here. Scanning a site you do not own with active payloads is unauthorised
     * testing, so the gate is data, not a code path.
     */
    verifiedDomain: boolean('verified_domain').notNull().default(false),
    /**
     * The secret half of the DNS proof: the value the owner publishes at
     * `_scanlyfix.<host>`. Generated once per project and kept afterwards — a
     * token that rotated on every visit would invalidate a record somebody had
     * already added and was waiting to propagate.
     *
     * Unguessable on purpose. Anyone who can predict it can claim a domain
     * they do not control, and what that unlocks is permission to probe
     * somebody's Supabase and Firebase.
     */
    verificationToken: text('verification_token'),
    /**
     * When the proof was last confirmed. Domains change hands, and a flag with
     * no date behind it says "verified" forever — so the moment is recorded,
     * and a re-verification sweep has something to read.
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /**
     * Status-page polish (Phase 6.4). All three are owner-controlled and
     * nullable/false-by-default so a project created before this migration
     * behaves exactly as it did until the owner opts in.
     *
     *   logo_url          — image URL rendered next to the project name on
     *                       the public status page. https-only at the API.
     *   brand_color       — hex (#RRGGBB). Validated at the app layer.
     *   robots_indexable  — true by default; the page renders <meta
     *                       name="robots" content="noindex,nofollow"> when
     *                       the owner flips this off.
     */
    logoUrl: text('logo_url'),
    brandColor: text('brand_color'),
    robotsIndexable: boolean('robots_indexable').notNull().default(true),
    runtimeSpendCeilingMicroUsd: bigint('runtime_spend_ceiling_micro_usd', { mode: 'number' }),
    /**
     * Per-project signing secret for the Runtime SDK ingest endpoint.
     *
     * The SDK sends this in `x-runtime-signature`; the ingest route validates
     * it per-project using constant-time comparison. Each project gets its own
     * secret so a leaked key for one project cannot poison another.
     *
     * Nullable — existing projects have null until the owner opens the Guard
     * setup card, which calls getOrCreateRuntimeSecret() to generate one.
     * Generate via: randomBytes(32).toString('hex')   → 64-char hex string.
     */
    runtimeSigningSecret: text('runtime_signing_secret'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  },
  (t) => [index('projects_owner_idx').on(t.ownerId), index('projects_org_idx').on(t.orgId)],
)

/* -------------------------------------------------------------------------- */
/* Scans                                                                      */
/* -------------------------------------------------------------------------- */

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for anonymous landing-page scans, which belong to no project. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** Null when anonymous. `set null` keeps the scan's audit trail if the user is deleted. */
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Hashed, never raw — anonymous abuse forensics without storing a PII address. */
    anonIpHash: text('anon_ip_hash'),
    /**
     * The scanned URL lives on the scan, not only on the project: an anonymous
     * scan has no project, and a project's URL can change without rewriting
     * history.
     */
    url: text('url').notNull(),
    /**
     * Hostname of `url`, denormalised because the per-target rate limit counts
     * scans of a SITE, not of a URL. Limiting on the full URL is no limit at
     * all: /1, /2, /3 are three different strings pointing at one server.
     */
    targetHost: text('target_host').notNull(),
    profile: scanProfileEnum('profile').notNull().default('fast'),
    status: scanStatusEnum('status').notNull().default('queued'),
    /** Set when the worker picks the job up — distinct from `createdAt` (enqueued). */
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Denormalised wall-clock so the sub-45 s target stays measurable without a join. */
    durationMs: integer('duration_ms'),
    /** Written once at the scoring step; avoids re-aggregating findings on every page view. */
    scores: jsonb('scores').$type<ScanScores>(),
    contextMeta: jsonb('context_meta').$type<ScanContextMeta>(),
    /**
     * Which engine produced this reading. Every feature that subtracts one scan
     * from another must refuse to compare across a change in it — otherwise the
     * day you ship new checks, every monitored customer is told their site got
     * worse. Not nullable and not backfillable: a row without it can never be
     * compared to anything, so there is no useful default to invent later.
     */
    engineVersion: text('engine_version').notNull(),
    /** Denominator for "17 of 29 checks could run" and a second comparability signal. */
    checksRun: integer('checks_run').notNull(),
    /**
     * Checks that crashed or timed out. Our bugs, not the site's — kept so a
     * support question about a moved score has an answer, and so the scan can
     * show which pillars were only partly measured.
     */
    checkErrors: jsonb('check_errors')
      .$type<Array<{ checkId: string; message: string }>>()
      .notNull()
      .default([]),
    /** Failure reason (SsrfError, SafeFetchError, timeout…). Meaningful only when status = 'failed'. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Project scan history, newest first — the dashboard's hot query.
    index('scans_project_created_idx').on(t.projectId, desc(t.createdAt)),
    // The queue sweep: everything still 'queued' or stuck in 'running'.
    index('scans_status_idx').on(t.status),
    // Two hot reads share this shape: the short-TTL dedup lookup ("has this URL
    // been scanned at this depth recently?") and the diff's "previous scan of
    // the same URL at the same depth".
    index('scans_url_profile_created_idx').on(t.url, t.profile, desc(t.createdAt)),
    // The two rate-limit counters, both of which run on every scan request:
    // "how much has this visitor asked for lately" and "how much has this site
    // been asked about lately, by anyone".
    index('scans_anon_ip_created_idx').on(t.anonIpHash, desc(t.createdAt)),
    index('scans_target_host_created_idx').on(t.targetHost, desc(t.createdAt)),
  ],
)

/**
 * One row per `Finding` the engine emits — same field names, same semantics.
 * `remediation` and `fixPrompt` are not extras: they are the paid product, so
 * they persist with the finding instead of being regenerated on read.
 */
export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    /** Stable dot-namespaced id, e.g. "security.headers.hsts". Join key for scan-to-scan diffs — never rename. */
    checkId: text('check_id').notNull(),
    category: categoryEnum('category').notNull(),
    severity: severityEnum('severity').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** Raw observed values backing the claim. Shape varies per check, hence jsonb. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
    remediation: text('remediation').notNull(),
    fixPrompt: text('fix_prompt').notNull(),
    status: findingStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The results page reads exactly this: one scan's findings, worst-first.
    index('findings_scan_severity_idx').on(t.scanId, t.severity),
    // Score diffing joins the previous scan on check_id.
    index('findings_scan_check_idx').on(t.scanId, t.checkId),
  ],
)

/* -------------------------------------------------------------------------- */
/* Monitoring                                                                 */
/* -------------------------------------------------------------------------- */

export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: monitorTypeEnum('type').notNull(),
    /**
     * Seconds, not minutes — uptime's floor is 60 s and domain expiry runs
     * daily, so minutes cannot express both ends of the range.
     */
    intervalS: integer('interval_s').notNull().default(3600),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // monitors pgTable ke andar, existing columns ke baad ADD karo:
alertConfig: jsonb('alert_config')
  .$type<{
    failStatusCodes?: number[]
    maxLatencyMs?: number | null
    reminderIntervalMin?: 15 | 30 | 60 | 120 | null
    keywordCheck?: {
      type: 'should_contain' | 'should_not_contain'
      value: string
      caseSensitive?: boolean
    }
    expectedStatusCodes?: number[]
    httpMethod?: 'GET' | 'HEAD'
    customHeaders?: Array<{ key: string; valueEncrypted: string }>
    followRedirects?: boolean
    /**
     * Per-monitor channel routing — Phase 4. Same wire shape as the
     * AlertConfigSchema in `@scanlyfix/web/lib/alert-threshold.ts`. The
     * schema is the source of truth; this type mirrors it for the DB
     * layer so writes can be type-checked.
     */
    notifyChannels?: string[]
  }>()
  .default(sql`NULL`),
// WHY nullable default: existing monitors ka config null = default behavior
// Backward compatible — zero data migration needed
  },
  (t) => [
    // One monitor per kind per project: duplicates would silently double the
    // cron invocations (and the bill) for zero extra signal.
    uniqueIndex('monitors_project_type_idx').on(t.projectId, t.type),
    // The cron sweep's query: enabled monitors, least-recently-run first.
    index('monitors_due_idx').on(t.enabled, t.lastRunAt),
  ],
)

/** Append-only probe log. Powers the public status page and latency history. */
export const monitorEvents = pgTable(
  'monitor_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    detail: text('detail'),
    // monitorEvents pgTable ke andar, existing columns ke baad:
diff: jsonb('diff')
  .$type<MonitorEventDiff>()
  .default(sql`NULL`),
// WHY sql NULL default: Drizzle mein jsonb ke liye undefined != null —
// explicit SQL NULL se DB level pe column properly nullable rehta hai
  },
  (t) => [index('monitor_events_monitor_ts_idx').on(t.monitorId, desc(t.ts))],
)


// ─── 2. New table add karo (monitorEvents ke baad) ────────────────
export const webVitalsSnapshots = pgTable(
  'web_vitals_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    lcp: integer('lcp_ms'),
    fid: integer('fid_ms'),   // WHY kept: historical data; new rows = null
    inp: integer('inp_ms'),   // INP replaces FID — Google March 2024
    cls: real('cls'),        // WHY real: CLS = 0.0 to 1.0, float chahiye
    fcp: integer('fcp_ms'),
    ttfb: integer('ttfb_ms'),
    si: integer('si_ms'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('web_vitals_monitor_ts_idx').on(t.monitorId, desc(t.ts)),
  ],
)

/**
 * PSI API result cache.
 * Keyed by normalized URL — avoids re-running Lighthouse for same page within 6h.
 * WHY jsonb: WebVitalsResult shape may evolve; jsonb avoids ALTER TABLE on schema drift.
 */
export const psiCache = pgTable(
  'psi_cache',
  {
    url: text('url').primaryKey(),       // Normalized URL (trailing slash stripped)
    result: jsonb('result').notNull(),   // Full WebVitalsResult (ok, lcp, inp, cls, ...)
    cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
)

/* ─── Rollup Tables ──────────────────────────────────────────────────────────── */

/**
 * Hourly rollup of monitor events.
 * Aggregated by the rollup-worker Inngest function every hour.
 * Powers the 24h uptime view with fast queries.
 */
export const monitorHourlyRollups = pgTable(
  'monitor_hourly_rollups',
  {
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    totalChecks: integer('total_checks').notNull(),
    upChecks: integer('up_checks').notNull(),
    avgLatencyMs: integer('avg_latency_ms'),
    p95LatencyMs: integer('p95_latency_ms'),
    minLatencyMs: integer('min_latency_ms'),
    maxLatencyMs: integer('max_latency_ms'),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.hour] })],
)

/**
 * Daily rollup of monitor events.
 * Aggregated by the rollup-worker Inngest function daily.
 * Powers the 7d/30d uptime view and the 90-day status page strip.
 */
export const monitorDailyRollups = pgTable(
  'monitor_daily_rollups',
  {
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    day: timestamp('day', { withTimezone: true }).notNull(),
    totalChecks: integer('total_checks').notNull(),
    upChecks: integer('up_checks').notNull(),
    avgLatencyMs: integer('avg_latency_ms'),
    p95LatencyMs: integer('p95_latency_ms'),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.day] })],
)


/**
 * Delivery log, not configuration — one row per alert dispatched. A null
 * `sentAt` means queued or failed, which is what lets a retry be idempotent.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** "uptime_down" | "score_drop" | "domain_expiring" | "tls_expiring" — open-ended, so text. */
    kind: text('kind').notNull(),
    channel: alertChannelEnum('channel').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /**
     * Deduplication key for reminder alerts.
     * Format: `{kind}-{monitorId}-{incidentId}-{slot}` for downtime reminders.
     * NULL for non-reminder alerts (initial downtime, recovery, certificate alerts).
     * Used by recordAlertOnce to prevent duplicate reminder emails.
     */
    dedupKey: text('dedup_key'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('alerts_project_created_idx').on(t.projectId, desc(t.createdAt)),
    // Partial unique index for dedupKey — only enforce uniqueness when dedupKey is NOT NULL
    // This allows multiple alerts with NULL dedupKey (non-reminder alerts)
    uniqueIndex('alerts_dedup_key_unique_idx')
      .on(t.dedupKey)
      .where(isNotNull(t.dedupKey)),
  ],
)
/**
 * Alert channel configuration — one row per (project, channel).
 *
 * Stores the delivery target for each alert channel: Slack webhook URL,
 * email address, etc. The `config` jsonb holds channel-specific fields.
 * Webhook URLs are secrets — the API masks them in responses.
 */
export const alertChannels = pgTable('alert_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  channel: alertChannelEnum('channel').notNull(),
  /** Channel-specific config: { webhookUrl } for Slack, { email } for email. Stored as JSONB. */
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Incidents tracked for uptime monitors.
 * Created when a monitor experiences consecutive failures; resolved when probe recovers.
 *
 * Acknowledge + notes (Phase 5):
 *   - acknowledgedAt + acknowledgedBy together encode "I am on it". Both
 *     nullable so the unacknowledged state is the default; setting one
 *     without the other is a bug, callers set them as a pair.
 *   - notes is free-form text the on-call adds while investigating. Bounded
 *     at the API layer; nullable so ack-without-notes is cheap.
 *   - acknowledgedBy uses ON DELETE SET NULL so a deleted user does not
 *     wipe the incident's audit trail — the timestamp remains, the name
 *     becomes "deleted user".
 */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Duration in milliseconds — NULL while the incident is still ongoing. */
    durationMs: integer('duration_ms'),
    /** HTTP status code that first triggered this incident, if available. */
    statusCode: integer('status_code'),
    /** Human-readable detail / error message captured at incident start. */
    detail: text('detail'),
    /** When the on-call acknowledged this incident. NULL = still unhandled. */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    /**
     * The user who acknowledged. ON DELETE SET NULL so a user being removed
     * does not orphan the incident — the timestamp stays, the row lives on.
     */
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** On-call notes. NULL until someone adds them. */
    notes: text('notes'),
  },
  (t) => [
    // Primary query: list incidents for a monitor, newest first.
    index('incidents_monitor_started_idx').on(t.monitorId, desc(t.startedAt)),
    // Efficiently find the single open (unresolved) incident per monitor.
    index('incidents_unresolved_idx').on(t.monitorId, t.resolvedAt),
  ],
)

/**
 * Public-facing incident updates.
 *
 * An "update" is one post on the timeline shown to a customer during an
 * incident — the Statuspage-style "investigating → identified → monitoring
 * → resolved" sequence. The incident row carries the lifecycle facts
 * (started/resolved/duration); this table carries the human messages.
 *
 * `status` is free text rather than an enum because the vocabulary grows
 * (a future "postmortem" stage, or a per-component verb) and we don't want
 * an ALTER TYPE on a live table for that. Validation lives at the API
 * boundary (see `IncidentUpdateStatusSchema` in queries/incident-updates.ts).
 *
 * `createdBy` SET NULL on user delete, NOT CASCADE: a timeline post should
 * still be visible years later when its author has left the account.
 * `createdAt` defaults to `now()` and is set in DB so concurrent posts
 * can't lie about order.
 */
export const incidentUpdates = pgTable(
  'incident_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    message: text('message').notNull(),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One composite serves the two access patterns: timeline (ASC) and
    // "most recent" (DESC). Postgres reads it in either direction.
    index('incident_updates_incident_created_idx').on(t.incidentId, t.createdAt),
  ],
)

/**
 * Public status-page email subscribers.
 *
 * One row per (project, lowercased email). The token is the single
 * secret that drives both the double-opt-in confirm link AND the
 * one-click unsubscribe link — so a leak of one token cannot be
 * turned into a separate confirm or unsubscribe on another project,
 * and there is exactly one thing to invalidate when somebody replies
 * "stop emailing me".
 *
 * The row is created on subscribe with `confirmed = false`, then
 * flipped to `confirmed = true` on the confirm-click. We never email
 * anyone whose row is unconfirmed. `unsubscribed_at` is a soft-delete:
 * keeping the row makes "do not email this person again" enforceable
 * without races and gives a privacy request its audit trail.
 */
export const statusSubscribers = pgTable(
  'status_subscribers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Stored lowercased + trimmed. */
    email: text('email').notNull(),
    /** 32 random bytes hex-encoded; UNIQUE so the click handler resolves a
     *  token back to exactly one subscriber without exposing ids. */
    token: text('token').notNull(),
    confirmed: boolean('confirmed').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Soft-delete. Non-null = never email this row again. */
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    /**
     * Hashed visitor IP from lib/request.ts (salted SHA-256, never raw).
     * Powers the 5/hour subscribe rate limit per address. Null when the
     * row was created outside a request context (e.g. tests, future
     * data import).
     */
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One row per (project, email). Re-subscribing after an unsubscribe
    // is intentionally blocked — the existing row's unsubscribed_at stays set.
    uniqueIndex('status_subscribers_project_email_idx').on(t.projectId, t.email),
    // Click handler hot path: confirm and unsubscribe both look up by token.
    uniqueIndex('status_subscribers_token_idx').on(t.token),
    // The fan-out path: confirmed-and-active subscribers for a project.
    // Partial index keeps the scan small even after many unsubscribes pile up.
    index('status_subscribers_project_active_idx')
      .on(t.projectId)
      .where(sql`${t.confirmed} = true AND ${t.unsubscribedAt} IS NULL`),
    // Rate-limit hot path: how many subscribe attempts this visitor made
    // in the last hour. Partial index over the recent window keeps it small.
    index('status_subscribers_ip_hash_created_idx')
      .on(t.ipHash, t.createdAt)
      .where(sql`${t.ipHash} IS NOT NULL`),
  ],
)

/**
 * Recurring weekly maintenance windows.
 *
 * A row defines a slot (e.g. "Sundays 02:00–04:00 America/Los_Angeles")
 * during which alerts for the monitor are suppressed. Probes still run,
 * events still record — only the dispatch step short-circuits, exactly
 * like the one-shot snooze.
 *
 * The window's `startTime` is stored as `time` (no date, no zone) and the
 * row carries its own IANA `timezone`. The query layer projects the
 * current moment into that zone before comparing — there is no SQL trick
 * that survives DST transitions, and we want to be right around the year
 * boundary.
 *
 * `monitorId` is nullable so a future "project-wide maintenance" feature
 * has somewhere to land without a migration. The API and probe today
 * only ever pass a non-null id.
 */
export const maintenanceWindows = pgTable(
  'maintenance_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id').references(() => monitors.id, {
      onDelete: 'cascade',
    }),
    /** 0 = Sunday, 6 = Saturday. null = every day. */
    dayOfWeek: integer('day_of_week'),
    /** Local start time in the row's `timezone`. */
    startTime: time('start_time').notNull(),
    /** Window length in minutes. */
    durationMin: integer('duration_min').notNull(),
    /** IANA timezone name, e.g. "America/Los_Angeles". Defaults to UTC. */
    timezone: text('timezone').notNull().default('UTC'),
    /** User-supplied reason. Shown on the status page while active. */
    reason: text('reason'),
    /** Soft off-switch. Disabled rows are ignored by the probe. */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Who set it up. SET NULL on user delete so the window survives. */
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    // The hot path: "is THIS monitor in a window right now?" — partial
    // index over enabled rows for a given monitor, the smallest scan
    // the query can use.
    index('maintenance_windows_monitor_enabled_idx').on(t.monitorId, t.enabled),
  ],
)



/**
 * FILE: packages/db/src/schema.ts
 * ACTION: Two additions.
 *
 * ─── ADDITION 1 ──────────────────────────────────────────────────────────────
 * Add snoozedMonitors table after the incidents table.
 * ─────────────────────────────────────────────────────────────────────────────
 */
 
/* -------------------------------------------------------------------------- */
/* Snooze rules                                                                */
/* -------------------------------------------------------------------------- */
 
/**
 * Temporarily silences alerts for a monitor.
 *
 * One active snooze per monitor — the unique index on monitorId enforces
 * this. Replacing a snooze is delete + insert, not update, so the audit
 * trail stays clean.
 *
 * expiresAt = null means snoozed indefinitely until manually cleared.
 * The probe checks this before alerting — no event is raised while a
 * valid snooze row exists.
 */
export const snoozedMonitors = pgTable(
  'snoozed_monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    /** When the snooze expires. null = snoozed indefinitely. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Why it's snoozed — shown in the UI. */
    reason: text('reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One active snooze per monitor at a time.
    uniqueIndex('snoozed_monitors_monitor_idx').on(t.monitorId),
  ],
)
 



/* -------------------------------------------------------------------------- */
/* Access & billing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * API keys are credentials: only the hash is stored. The plaintext is shown
 * once at creation and never again, so a database dump cannot be replayed
 * against the API.
 *
 * SHA-256, deliberately, where a password would get bcrypt. A password is
 * short and human-chosen, so a fast hash is brute-forceable and a slow one is
 * the whole defence. A key here is 256 bits from a CSPRNG — unreachable by
 * brute force at any hash speed — and it arrives on EVERY API request, where a
 * 100 ms KDF would be a self-inflicted rate limit.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** User-facing label ("CI", "laptop") — the only way to identify a key after creation. */
    name: text('name'),
    /**
     * The first few characters of the plaintext, kept in the clear so a key
     * found in a CI log can be matched to a row and revoked. Without it the
     * list is names and dates, and an account with two keys called "CI" has no
     * way to tell which one leaked — so it revokes both, or neither.
     *
     * Safe to store: it exposes a known-length slice of a 256-bit secret and
     * leaves the rest unguessable. It is not a lookup key — `keyHash` is.
     */
    prefix: text('prefix'),
    keyHash: text('key_hash').notNull().unique(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_keys_user_idx').on(t.userId)],
)

/**
 * Stripe mirror, keyed by user because a user has exactly one subscription.
 * `plan` and `status` stay `text`: Stripe's status vocabulary (trialing,
 * past_due, incomplete_expired, …) grows and tier names get rebranded — an enum
 * there means an ALTER TYPE every time pricing changes.
 */
export const subscriptions = pgTable('subscriptions', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /**
   * Provider-neutral on purpose. These held `stripe_` names until billing
   * moved to Razorpay, and renaming a column across a live table to follow a
   * vendor is a migration nobody wants to run twice. What the product needs to
   * know is "which customer at whichever processor we use", and that does not
   * change when the processor does.
   *
   * Null until the first payment — a free account never reaches the processor.
   */
  billingCustomerId: text('billing_customer_id').unique(),
  /** Webhooks arrive keyed by this; needed to map an event back to a user. */
  billingSubscriptionId: text('billing_subscription_id').unique(),
  plan: text('plan').notNull().default('free'),
  status: text('status').notNull().default('active'),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Generated PDF/Markdown exports; the file itself lives in Supabase Storage. */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    format: reportFormatEnum('format').notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reports_scan_idx').on(t.scanId)],
)

/* -------------------------------------------------------------------------- */
/* GitHub repositories                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One row per GitHub App installation a user authorised. An installation is a
 * SCOPED, REVOCABLE grant the user makes at install time (they pick which
 * repos); it is not a long-lived token. The token itself is minted per request
 * from the App's private key and lives ~1h, so the only thing stored here is
 * GitHub's stable installation id plus the account it belongs to.
 *
 * Separate from the Supabase-managed GitHub OAuth used for login: that proves
 * who someone is, this proves which repos they let us read.
 */
export const githubInstallations = pgTable(
  'github_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** GitHub's numeric installation id — the thing the JWT/token exchange keys on. */
    installationId: bigint('installation_id', { mode: 'number' }).notNull().unique(),
    accountLogin: text('account_login').notNull(),
    /** "Organization" | "User" — drives the org-vs-person UI copy. */
    accountType: text('account_type').notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('github_installations_user_installation_idx').on(t.userId, t.installationId)],
)

/**
 * Repos a user has chosen to scan, picked from the installation's granted set.
 * Stored rather than re-listed on every scan because a scan needs a stable
 * `repo_id` to hang history off, and a repo the user removed from the grant
 * must be detectable (the scan then fails cleanly on a revoked token).
 */
export const githubRepos = pgTable(
  'github_repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => githubInstallations.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    private: boolean('private').notNull().default(false),
    /** GitHub's numeric repo id — stable across renames, unlike full_name. */
    githubId: bigint('github_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('github_repos_installation_owner_name_idx').on(t.installationId, t.owner, t.name)],
)

/**
 * Parallel to `scans`, with its own engine version for comparability. A repo
 * scan never shares the `scans` table because a repo scan's score is across
 * repo pillars (secrets/supply-chain/…), not site pillars (seo/aeo/…), and a
 * `kind` column would force one scoring model to pretend to be two.
 */
export const repoScans = pgTable(
  'repo_scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => githubRepos.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    profile: repoScanProfileEnum('profile').notNull().default('shallow'),
    status: repoScanStatusEnum('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    scores: jsonb('scores').$type<RepoScanScores>(),
    contextMeta: jsonb('context_meta').$type<RepoScanContextMeta>(),
    /**
     * Which repo engine produced this reading. The same comparability rule as
     * scans.engine_version applies: a feature that diffs two repo scans must
     * refuse across a change in it, or shipping the deep-scan checks would tell
     * every monitored repo it got worse.
     */
    engineVersion: text('engine_version').notNull(),
    checksRun: integer('checks_run').notNull(),
    checkErrors: jsonb('check_errors')
      .$type<Array<{ checkId: string; message: string }>>()
      .notNull()
      .default([]),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('repo_scans_repo_created_idx').on(t.repoId, desc(t.createdAt)),
    index('repo_scans_status_idx').on(t.status),
  ],
)

/**
 * Parallel to `findings`; same field shape, repo_category enum. `severity` is
 * the SAME severityEnum as site findings — a leaked key is `critical` whether
 * it is in a bundle or a commit, and one ladder is how the report keeps that.
 */
export const repoFindings = pgTable(
  'repo_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoScanId: uuid('repo_scan_id')
      .notNull()
      .references(() => repoScans.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    category: repoCategoryEnum('category').notNull(),
    severity: severityEnum('severity').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
    remediation: text('remediation').notNull(),
    fixPrompt: text('fix_prompt').notNull(),
    status: repoFindingStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('repo_findings_scan_severity_idx').on(t.repoScanId, t.severity),
    index('repo_findings_scan_check_idx').on(t.repoScanId, t.checkId),
  ],
)



// ─── ADD: dns_snapshots table ─────────────────────────────────────────────────
// WHY: Har DNS check ka snapshot store karte hain taaki next check mein
//      compare kar sakein aur drift detect ho sake.

export const dnsSnapshots = pgTable(
  'dns_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
      // WHY cascade: monitor delete ho toh uske saare DNS snapshots bhi clean ho jayein

    records: jsonb('records')
      .$type<Array<{ type: 'A' | 'CNAME' | 'NS'; value: string }>>()
      .notNull(),
      // WHY jsonb: DNS records variable-length hote hain, structured columns fit nahi honge

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // WHY this index: latest snapshot fetch hoga monitorId + time se — ye query fast karega
    index('dns_snapshots_monitor_created_idx').on(t.monitorId, desc(t.createdAt)),
  ],
)





// ─────────────────────────────────────────────────────────────
// RUNTIME — AUTH PROBER
// ─────────────────────────────────────────────────────────────

/** Paths we probe nightly. Baseline is per-target — naya target
 *  pehli raat sirf record hota hai, judge nahi hota. */
export const runtimeProberTargets = pgTable(
  'runtime_prober_targets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    method: text('method').notNull().default('GET'),
    /** 'default' = common-path guess · 'guard' = SDK se real route (Phase 2) · 'manual' */
    source: text('source').notNull().default('default'),
    /** null = baseline abhi record nahi hua */
    baselineStatus: integer('baseline_status'),
    baselineAt: timestamp('baseline_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastActualStatus: integer('last_actual_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('runtime_prober_targets_uq').on(t.projectId, t.path, t.method)],
);

/** Ek finding = "ye darwaza locked tha, ab khula hai". Resolved hone
 *  ke baad re-find ho sakta hai — isliye unique constraint nahi lagayi. */
export const runtimeProberFindings = pgTable(
  'runtime_prober_findings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').references(() => runtimeProberTargets.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    method: text('method').notNull().default('GET'),
    baselineStatus: integer('baseline_status').notNull(),
    actualStatus: integer('actual_status').notNull(),
    /** 'critical' = sensitive path (/admin, /api/*) · 'high' = baaki */
    severity: text('severity').notNull().default('high'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('runtime_prober_findings_project_idx').on(t.projectId, t.resolvedAt)],
);



// Guard
export const runtimeRoutes = pgTable(
  'runtime_routes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    method: text('method').notNull(),
    kind: text('kind').notNull().default('route'), // 'route' | 'server_action'
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('runtime_routes_identity_uq').on(t.projectId, t.pattern, t.method)],
);

export const runtimeRouteStats = pgTable(
  'runtime_route_stats',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    routeId: uuid('route_id').notNull().references(() => runtimeRoutes.id, { onDelete: 'cascade' }),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    withSession: integer('with_session').notNull().default(0),
    withoutSession: integer('without_session').notNull().default(0),
  },
  (t) => [uniqueIndex('runtime_route_stats_uq').on(t.routeId, t.hour)],
);



/* -------------------------------------------------------------------------- */
/* Runtime AI Logs & Spend                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Raw telemetry events recorded from AI provider calls (OpenAI, Anthropic, etc.).
 * Zero-proxy policy: secret keys never leave the caller's server; only metadata
 * (model, tokens, latency, cost) is ingested.
 */
export const runtimeAiCalls = pgTable(
  'runtime_ai_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    userHash: text('user_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('runtime_ai_calls_project_created_idx').on(t.projectId, t.createdAt)],
);

/** Velocity-alert hourly dedupe — unique(project, hour) = ek hour, ek email. */
export const runtimeSpendAlerts = pgTable(
  'runtime_spend_alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    spentMicroUsd: bigint('spent_micro_usd', { mode: 'number' }).notNull(),
    projectedMicroUsd: bigint('projected_micro_usd', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('runtime_spend_alerts_uq').on(t.projectId, t.hour)],
);



/* -------------------------------------------------------------------------- */
/* Relations — required for the `db.query.*` API. `.references()` alone only   */
/* emits the SQL constraint; it does not teach Drizzle how to join.           */
/* -------------------------------------------------------------------------- */

export const usersRelations = relations(users, ({ one, many }) => ({
  projects: many(projects),
  memberships: many(memberships),
  apiKeys: many(apiKeys),
  ownedOrganizations: many(organizations),
  subscription: one(subscriptions),
  githubInstallations: many(githubInstallations),
}))

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, { fields: [organizations.ownerId], references: [users.id] }),
  memberships: many(memberships),
  projects: many(projects),
}))

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, { fields: [memberships.orgId], references: [organizations.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  organization: one(organizations, { fields: [projects.orgId], references: [organizations.id] }),
  scans: many(scans),
  monitors: many(monitors),
  alerts: many(alerts),
  alertChannels: many(alertChannels),
  statusSubscribers: many(statusSubscribers),
  aiCalls: many(runtimeAiCalls),
  spendAlerts: many(runtimeSpendAlerts),
}))

export const scansRelations = relations(scans, ({ one, many }) => ({
  project: one(projects, { fields: [scans.projectId], references: [projects.id] }),
  requester: one(users, { fields: [scans.requestedBy], references: [users.id] }),
  findings: many(findings),
  reports: many(reports),
}))

export const findingsRelations = relations(findings, ({ one }) => ({
  scan: one(scans, { fields: [findings.scanId], references: [scans.id] }),
}))

export const monitorsRelations = relations(monitors, ({ one, many }) => ({
  project: one(projects, { fields: [monitors.projectId], references: [projects.id] }),
  events: many(monitorEvents),
  incidents: many(incidents),
}))

export const monitorEventsRelations = relations(monitorEvents, ({ one }) => ({
  monitor: one(monitors, { fields: [monitorEvents.monitorId], references: [monitors.id] }),
}))


/**
 * ─── ADDITION 2 ──────────────────────────────────────────────────────────────
 * ─────────────────────────────────────────────────────────────────────────────
 */
 
export const incidentUpdatesRelations = relations(incidentUpdates, ({ one }) => ({
  incident: one(incidents, {
    fields: [incidentUpdates.incidentId],
    references: [incidents.id],
  }),
  /** Author of the post. Null after user deletion (SET NULL). */
  author: one(users, {
    fields: [incidentUpdates.createdBy],
    references: [users.id],
  }),
}))

export const snoozedMonitorsRelations = relations(snoozedMonitors, ({ one }) => ({
  monitor: one(monitors, {
    fields: [snoozedMonitors.monitorId],
    references: [monitors.id],
  }),
  createdBy: one(users, {
    fields: [snoozedMonitors.createdBy],
    references: [users.id],
  }),
}))



export const incidentsRelations = relations(incidents, ({ one, many }) => ({
  monitor: one(monitors, {
    fields: [incidents.monitorId],
    references: [monitors.id],
  }),
  updates: many(incidentUpdates),
  /**
   * The user who acknowledged this incident. May be null when the incident
   * has not been acknowledged, OR when the user was deleted (the timestamp
   * stays, the name becomes "deleted user").
   */
  acknowledger: one(users, {
    fields: [incidents.acknowledgedBy],
    references: [users.id],
    relationName: 'incident_acknowledger',
  }),
}))

export const maintenanceWindowsRelations = relations(maintenanceWindows, ({ one }) => ({
  monitor: one(monitors, {
    fields: [maintenanceWindows.monitorId],
    references: [monitors.id],
  }),
  createdBy: one(users, {
    fields: [maintenanceWindows.createdBy],
    references: [users.id],
    relationName: 'maintenance_window_creator',
  }),
}))

export const dnsSnapshotsRelations = relations(dnsSnapshots, ({ one }) => ({
  monitor: one(monitors, {
    fields: [dnsSnapshots.monitorId],
    references: [monitors.id],
  }),
}))

export const alertsRelations = relations(alerts, ({ one }) => ({
  project: one(projects, { fields: [alerts.projectId], references: [projects.id] }),
}))

export const alertChannelsRelations = relations(alertChannels, ({ one }) => ({
  project: one(projects, { fields: [alertChannels.projectId], references: [projects.id] }),
}))

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}))

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
}))

export const reportsRelations = relations(reports, ({ one }) => ({
  scan: one(scans, { fields: [reports.scanId], references: [scans.id] }),
}))

export const githubInstallationsRelations = relations(githubInstallations, ({ one, many }) => ({
  user: one(users, { fields: [githubInstallations.userId], references: [users.id] }),
  repos: many(githubRepos),
}))

export const githubReposRelations = relations(githubRepos, ({ one, many }) => ({
  installation: one(githubInstallations, { fields: [githubRepos.installationId], references: [githubInstallations.id] }),
  scans: many(repoScans),
}))

export const repoScansRelations = relations(repoScans, ({ one, many }) => ({
  repo: one(githubRepos, { fields: [repoScans.repoId], references: [githubRepos.id] }),
  requester: one(users, { fields: [repoScans.requestedBy], references: [users.id] }),
  findings: many(repoFindings),
}))

export const repoFindingsRelations = relations(repoFindings, ({ one }) => ({
  scan: one(repoScans, { fields: [repoFindings.repoScanId], references: [repoScans.id] }),
}))

// ─── 3. Relation add karo ─────────────────────────────────────────
export const webVitalsSnapshotsRelations = relations(webVitalsSnapshots, ({ one }) => ({
  monitor: one(monitors, {
    fields: [webVitalsSnapshots.monitorId],
    references: [monitors.id],
  }),
}))

export const runtimeAiCallsRelations = relations(runtimeAiCalls, ({ one }) => ({
  project: one(projects, {
    fields: [runtimeAiCalls.projectId],
    references: [projects.id],
  }),
}))

export const runtimeSpendAlertsRelations = relations(runtimeSpendAlerts, ({ one }) => ({
  project: one(projects, {
    fields: [runtimeSpendAlerts.projectId],
    references: [projects.id],
  }),
}))

/* -------------------------------------------------------------------------- */
/* Inferred row types — import these instead of hand-writing DTOs.            */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert
export type Membership = typeof memberships.$inferSelect
export type NewMembership = typeof memberships.$inferInsert
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
/** 'fast' | 'deep' — the enum's values, so callers never retype the union. */
export type ScanProfile = (typeof scanProfileEnum.enumValues)[number]

export type Scan = typeof scans.$inferSelect
export type NewScan = typeof scans.$inferInsert
/** Persisted finding row. Distinct from `@scanlyfix/checks`'s in-memory `Finding`. */
export type FindingRow = typeof findings.$inferSelect
export type NewFindingRow = typeof findings.$inferInsert
export type Monitor = typeof monitors.$inferSelect
export type NewMonitor = typeof monitors.$inferInsert
export type MonitorEvent = typeof monitorEvents.$inferSelect
export type NewMonitorEvent = typeof monitorEvents.$inferInsert
export type Alert = typeof alerts.$inferSelect
export type NewAlert = typeof alerts.$inferInsert
export type AlertChannelRow = typeof alertChannels.$inferSelect
export type NewAlertChannelRow = typeof alertChannels.$inferInsert
export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert
export type Subscription = typeof subscriptions.$inferSelect
export type NewSubscription = typeof subscriptions.$inferInsert
export type Report = typeof reports.$inferSelect
export type NewReport = typeof reports.$inferInsert
export type GithubInstallation = typeof githubInstallations.$inferSelect
export type NewGithubInstallation = typeof githubInstallations.$inferInsert
export type GithubRepo = typeof githubRepos.$inferSelect
export type NewGithubRepo = typeof githubRepos.$inferInsert
/** 'shallow' | 'deep' — the enum's values, so callers never retype the union. */
export type RepoScanProfile = (typeof repoScanProfileEnum.enumValues)[number]
export type RepoScan = typeof repoScans.$inferSelect
export type NewRepoScan = typeof repoScans.$inferInsert
/** Persisted repo finding row. Distinct from `@scanlyfix/repo-checks`'s in-memory `RepoFinding`. */
export type RepoFindingRow = typeof repoFindings.$inferSelect
export type NewRepoFindingRow = typeof repoFindings.$inferInsert
export type Incident = typeof incidents.$inferSelect
export type NewIncident = typeof incidents.$inferInsert
export type IncidentUpdate = typeof incidentUpdates.$inferSelect
export type NewIncidentUpdate = typeof incidentUpdates.$inferInsert
export type StatusSubscriber = typeof statusSubscribers.$inferSelect
export type NewStatusSubscriber = typeof statusSubscribers.$inferInsert
export type MaintenanceWindow = typeof maintenanceWindows.$inferSelect
export type NewMaintenanceWindow = typeof maintenanceWindows.$inferInsert
export type DnsSnapshot = typeof dnsSnapshots.$inferSelect
export type NewDnsSnapshot = typeof dnsSnapshots.$inferInsert
export type WebVitalsSnapshot = typeof webVitalsSnapshots.$inferSelect
export type NewWebVitalsSnapshot = typeof webVitalsSnapshots.$inferInsert
export type SnoozedMonitor = typeof snoozedMonitors.$inferSelect
export type NewSnoozedMonitor = typeof snoozedMonitors.$inferInsert
export type RuntimeAiCall = typeof runtimeAiCalls.$inferSelect
export type NewRuntimeAiCall = typeof runtimeAiCalls.$inferInsert
export type RuntimeSpendAlert = typeof runtimeSpendAlerts.$inferSelect
export type NewRuntimeSpendAlert = typeof runtimeSpendAlerts.$inferInsert

 