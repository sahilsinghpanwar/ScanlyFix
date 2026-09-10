/*
 * Pure threshold evaluation — no DB, no side effects, fully testable.
 *
 * WHY alag file (not in uptime-probe.ts):
 *  - Unit test karna easy — just import and call
 *  - Future: web-vitals bhi custom thresholds use kar sakta hai
 *  - alert-message.ts mein bhi import kar sakte ho for detail strings
 */

import { z } from 'zod'

// ─── Schema ────────────────────────────────────────────────────────────────────
// WHY Zod: DB se aaya jsonb untyped hota hai — runtime validate karo
// WHY exported: API route + monitors.ts dono yahi use karein

/**
 * Custom header for HTTP requests.
 * valueEncrypted is stored encrypted in DB.
 */
const CustomHeaderSchema = z.object({
  key: z
    .string()
    .min(1, 'Header key cannot be empty')
    .max(100, 'Header key too long')
    .regex(/^[a-zA-Z0-9-]+$/, 'Header key must be alphanumeric with hyphens'),
  valueEncrypted: z
    .string()
    .min(1, 'Header value cannot be empty')
    .max(1000, 'Header value too long'),
})

/**
 * Keyword check configuration.
 * Used to verify response body contains/doesn't contain specific content.
 */
const KeywordCheckSchema = z.object({
  type: z.enum(['should_contain', 'should_not_contain']),
  value: z
    .string()
    .min(1, 'Keyword cannot be empty')
    .max(500, 'Keyword too long (max 500 chars)'),
  caseSensitive: z.boolean().default(false).optional(),
})

/**
 * Full alert configuration schema for monitors.
 *
 * Fields:
 *   - failStatusCodes: HTTP status codes that count as DOWN
 *   - maxLatencyMs: Max acceptable latency in ms
 *   - reminderIntervalMin: Reminder interval for downtime alerts
 *   - keywordCheck: Response body content verification
 *   - expectedStatusCodes: Expected HTTP status codes (empty = any 2xx)
 *   - httpMethod: HTTP method for requests (GET or HEAD)
 *   - customHeaders: Custom headers for HTTP requests
 *   - followRedirects: Whether to follow HTTP redirects
 */
export const AlertConfigSchema = z.object({
  /**
   * HTTP status codes that count as DOWN.
   *
   * Examples:
   *   [500, 502, 503, 504]       → 5xx only
   *   [400,401,...,599]          → any non-2xx/3xx
   *   null / undefined / []      → default: status >= 400 = down
   */
  failStatusCodes: z
    .array(z.number().int().min(100).max(599))
    .max(50)          // sanity cap — 50 status codes enough
    .optional(),

  /**
   * Max acceptable latency in ms. null = no latency threshold.
   * WHY max 60_000: a probe timeout is 15s — 60s threshold is meaningless
   */
  maxLatencyMs: z
    .number()
    .int()
    .min(100)         // below 100ms threshold is noise
    .max(60_000)
    .nullable()
    .optional(),

  /**
   * Reminder interval for downtime alerts in minutes.
   * null = reminders disabled (default)
   * Options: 15, 30, 60, 120
   *
   * When enabled, sends reminder emails every N minutes while the site is down.
   * Reminders stop when the site recovers.
   */
  reminderIntervalMin: z
    .union([
      z.literal(15),
      z.literal(30),
      z.literal(60),
      z.literal(120),
    ])
    .nullable()
    .optional(),

  /**
   * Keyword check configuration.
   * Verifies response body contains/doesn't contain specific content.
   */
  keywordCheck: KeywordCheckSchema.optional(),

  /**
   * Expected HTTP status codes.
   * Empty array or undefined = any 2xx is OK.
   * Example: [200, 201, 204] = only these codes are OK.
   */
  expectedStatusCodes: z
    .array(z.number().int().min(100).max(599))
    .max(20)          // sanity cap
    .optional(),

  /**
   * HTTP method for requests.
   * GET = full response body (for keyword check)
   * HEAD = headers only (faster, no body)
   */
  httpMethod: z
    .enum(['GET', 'HEAD'])
    .default('GET')
    .optional(),

  /**
   * Custom headers for HTTP requests.
   * Max 5 headers allowed.
   * Keys must be alphanumeric with hyphens.
   * Values are stored encrypted.
   */
  customHeaders: z
    .array(CustomHeaderSchema)
    .max(5, 'Maximum 5 custom headers allowed')
    .optional(),

  /**
   * Whether to follow HTTP redirects.
   * true = follow redirects (default)
   * false = fail on redirect
   */
  followRedirects: z
    .boolean()
    .default(true)
    .optional(),

  /**
   * Per-monitor alert channel routing.
   *
   * Each entry is an `alert_channels.id` (UUID). The list restricts which
   * configured channels receive an alert for THIS monitor:
   *   - empty / undefined → deliver to every enabled channel on the project
   *     (backward-compatible default — existing monitors with no config keep
   *     the previous behaviour)
   *   - non-empty list → deliver ONLY to the channels whose id appears here
   *     AND which are currently enabled. A channel that was deleted or
   *     disabled is silently skipped — a stale id is not a hard error, since
   *     the user cannot control which side reconciles first.
   *
   * The project's primary email (the project owner's address) is treated
   * specially: it is delivered UNLESS the list is non-empty AND does NOT
   * contain the email channel. Rationale: the email address is not stored
   * as a row in `alert_channels`, so it cannot appear in this list. The
   * "no email" decision is therefore encoded as "list is non-empty".
   *
   * The list is bounded so a malicious or buggy client cannot bloat the
   * jsonb. Five entries is enough for any realistic project — if a
   * project has more channels, the user should fall back to the default
   * (all enabled) by leaving the list empty.
   */
  notifyChannels: z
    .array(z.string().uuid('Channel id must be a UUID'))
    .max(5, 'Maximum 5 channels per monitor')
    .optional(),

  /**
   * Number of consecutive failed probes required before an alert is sent.
   *
   * Defaults to 2 in the probe code. Anything between 1 and 5 is allowed.
   *
   * WHY a number and not a boolean: a single failure is often a deploy blip,
   * and a product that emails on every transient outage teaches people to
   * filter it. 2 in a row is a site that is actually down. 5 is a paranoid
   * mode for teams that prefer to triage in their own tooling first.
   */
  failuresBeforeAlert: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional(),

  /**
   * Email address to deliver monitor alerts to. Stored as a string in the
   * config jsonb (no encryption — the project's primary email is already
   * visible elsewhere in the UI). null disables email routing; the default
   * behaviour is to deliver to the project owner.
   */
  alertEmail: z
    .string()
    .email()
    .nullable()
    .optional(),
})

export type AlertConfig = z.infer<typeof AlertConfigSchema>

// ─── Size Validation ───────────────────────────────────────────────────────────
/**
 * Maximum size of alertConfig in bytes (4KB).
 * WHY: Prevent abuse — someone could send huge headers/keywords.
 */
const MAX_CONFIG_SIZE_BYTES = 4096

/**
 * Validates total config size is within limits.
 * Must be called after Zod validation passes.
 */
export function validateConfigSize(config: AlertConfig): { ok: boolean; reason?: string } {
  const serialized = JSON.stringify(config)
  if (serialized.length > MAX_CONFIG_SIZE_BYTES) {
    return {
      ok: false,
      reason: `Config too large (${serialized.length} bytes, max ${MAX_CONFIG_SIZE_BYTES})`,
    }
  }
  return { ok: true }
}

// ─── Preset Helpers ────────────────────────────────────────────────────────────
// WHY presets: UI mein dropdown options — user ne samjhana nahi padta

export const ALERT_PRESETS = {
  '5xx_only': {
    label: 'Alert on 5xx errors only',
    failStatusCodes: [500, 502, 503, 504, 507, 508, 510, 511],
  },
  '4xx_and_5xx': {
    label: 'Alert on 4xx and 5xx errors',
    failStatusCodes: Array.from({ length: 200 }, (_, i) => 400 + i),
  },
  non_200: {
    label: 'Alert on any error response (4xx + 5xx)',
    failStatusCodes: Array.from({ length: 200 }, (_, i) => 400 + i),
  },
  default: {
    label: 'Alert on any error (default — status ≥ 400)',
    failStatusCodes: undefined, // uses built-in logic
  },
} as const

export type AlertPresetKey = keyof typeof ALERT_PRESETS

// ─── Core Evaluator ────────────────────────────────────────────────────────────

interface RawOutcome {
  statusCode: number | null
  latencyMs: number | null
  body?: string // Response body for keyword check (first 64KB)
}

interface EvaluationResult {
  ok: boolean
  // WHY include reason: uptime-probe detail string mein use hoga
  reason: string | null
}

/**
 * Applies alert config thresholds to a raw probe outcome.
 *
 * WHY returns EvaluationResult (not boolean):
 * Caller needs to know WHY it failed — for detail string in monitorEvents.
 *
 * WHY null alertConfig = default behavior:
 * Existing monitors without config should behave exactly as before.
 * Backward compatible — zero migration needed for existing data.
 *
 * Evaluation order:
 *   1. Status code check (expectedStatusCodes or failStatusCodes or default ≥400)
 *   2. Latency check (maxLatencyMs)
 *   3. Keyword check (keywordCheck)
 */
export function evaluateOutcome(
  outcome: RawOutcome,
  alertConfig: AlertConfig | null | undefined,
): EvaluationResult {
  const { statusCode, latencyMs, body } = outcome
  const reasons: string[] = []

  // ── Status code evaluation ──────────────────────────────────────────────────
  let statusDown = false

  if (statusCode !== null) {
    // Priority 1: expectedStatusCodes (exact match for 2xx)
    if (
      alertConfig?.expectedStatusCodes &&
      alertConfig.expectedStatusCodes.length > 0
    ) {
      // Only listed codes are OK — anything else is down
      statusDown = !alertConfig.expectedStatusCodes.includes(statusCode)
      if (statusDown) {
        reasons.push(`HTTP ${statusCode} (expected: ${alertConfig.expectedStatusCodes.join(', ')})`)
      }
    }
    // Priority 2: failStatusCodes (listed codes count as down)
    else if (
      alertConfig?.failStatusCodes &&
      alertConfig.failStatusCodes.length > 0
    ) {
      // Custom threshold — only listed codes count as down
      statusDown = alertConfig.failStatusCodes.includes(statusCode)
      if (statusDown) {
        reasons.push(`HTTP ${statusCode}`)
      }
    }
    // Priority 3: Default behavior (status >= 400 = down)
    else {
      // Default: status >= 400 = down (existing uptime-probe behavior)
      statusDown = statusCode >= 400
      if (statusDown) {
        reasons.push(`HTTP ${statusCode}`)
      }
    }
  }

  // ── Latency evaluation ──────────────────────────────────────────────────────
  let latencyDown = false

  if (
    alertConfig?.maxLatencyMs != null &&
    latencyMs !== null &&
    latencyMs > alertConfig.maxLatencyMs
  ) {
    latencyDown = true
    reasons.push(`${latencyMs}ms > ${alertConfig.maxLatencyMs}ms threshold`)
  }

  // ── Keyword evaluation ──────────────────────────────────────────────────────
  let keywordDown = false

  if (alertConfig?.keywordCheck && body !== undefined) {
    const { type, value, caseSensitive = false } = alertConfig.keywordCheck

    // Search in first 64KB of body
    const searchBody = body.slice(0, 65536)
    const searchValue = caseSensitive ? value : value.toLowerCase()
    const searchText = caseSensitive ? searchBody : searchBody.toLowerCase()

    const found = searchText.includes(searchValue)

    if (type === 'should_contain' && !found) {
      keywordDown = true
      reasons.push(`keyword '${value}' not found`)
    } else if (type === 'should_not_contain' && found) {
      keywordDown = true
      reasons.push(`keyword '${value}' found`)
    }
  }

  const isDown = statusDown || latencyDown || keywordDown

  return {
    ok: !isDown,
    reason: reasons.length > 0 ? reasons.join(', ') : null,
  }
}

// ─── Config Validator ──────────────────────────────────────────────────────────
/**
 * Validate karta hai user-supplied alertConfig before DB mein save karo.
 * Returns parsed config or error message.
 *
 * Validation order:
 *   1. Zod schema validation (structure + types)
 *   2. Size validation (prevent abuse)
 */
export function parseAlertConfig(
  raw: unknown,
): { ok: true; config: AlertConfig } | { ok: false; reason: string } {
  // Step 1: Zod validation
  const result = AlertConfigSchema.safeParse(raw)
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues[0]?.message ?? 'Invalid alert config',
    }
  }

  // Step 2: Size validation
  const sizeCheck = validateConfigSize(result.data)
  if (!sizeCheck.ok) {
    return {
      ok: false,
      reason: sizeCheck.reason ?? 'Config too large',
    }
  }

  return { ok: true, config: result.data }
}

// ─── Notify-Channel Resolution ────────────────────────────────────────────────
/**
 * Resolves the effective set of channel ids to dispatch an alert to, given
 * the monitor's alertConfig and the project's currently enabled channels.
 *
 * Returns a `ChannelRouting` shape that distinguishes the email decision
 * (which is not stored as a row in `alert_channels`) from the secondary
 * channel list. The caller — `deliverAlert` — uses this to decide whether
 * to send the primary email and which Slack/Discord/webhook rows to fan
 * out to.
 *
 * The three possible states, in plain English:
 *   1. notifyChannels is undefined OR empty
 *      → send email AND fan out to every enabled channel.
 *        This is the "default" path, taken for monitors that have not
 *        opted in to per-monitor routing.
 *   2. notifyChannels is a non-empty list
 *      → suppress the email (the user explicitly said "not email")
 *        AND only fan out to the channels whose id is in the list.
 *      A id in the list that does not match an enabled channel is silently
 *      skipped — a stale id from a deleted channel is not a hard error.
 *   3. The config exists but has no notifyChannels key
 *      → same as (1) — backward compatible.
 *
 * The function is pure: it does not read from the DB, it does not log, it
 * does not throw. Easy to unit-test, easy to call from any probe path.
 */
export interface ChannelRouting {
  /** True when the primary email should go out. */
  sendEmail: boolean
  /**
   * The subset of channel ids the caller should fan out to. Empty array
   * means "no secondary channels". The caller is responsible for joining
   * this against the project-level `getAlertChannels` list.
   */
  secondaryChannelIds: readonly string[]
}

export function resolveNotifyChannels(
  alertConfig: AlertConfig | null | undefined,
  /** Ids of channels currently enabled for the project. */
  enabledChannelIds: readonly string[],
): ChannelRouting {
  // Default path: no per-monitor routing configured.
  const explicit = alertConfig?.notifyChannels
  if (!explicit || explicit.length === 0) {
    return {
      sendEmail: true,
      // Empty array = "no restriction" — the caller uses ALL enabled channels.
      secondaryChannelIds: enabledChannelIds,
    }
  }

  // Explicit per-monitor routing. The list is the user's intent; the
  // intersection with the currently enabled channels is what we actually
  // fan out to. A stale id is not an error.
  const enabledSet = new Set(enabledChannelIds)
  const intersected = explicit.filter((id) => enabledSet.has(id))
  return {
    sendEmail: false,
    secondaryChannelIds: intersected,
  }
}