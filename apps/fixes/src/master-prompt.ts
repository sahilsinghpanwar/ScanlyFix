/**
 * The master prompt — the one piece of wording the whole feature rests on.
 *
 * The product's promise is "the prompt that fixes it": not advice about the
 * issue, but a work order precise enough that an AI coding agent (Cursor,
 * Claude Code, Copilot Workspace) can act on it without the user writing a
 * word. The model is told what the output IS, what it may use, and where the
 * edges are — because an LLM handed a finding will happily pad it with
 * invented context, and an invented fix is worse than none.
 *
 * Kept here rather than beside the engine on purpose: the static `fixPrompt`
 * the engine stamps on every finding at scan time is built from templates in
 * @scanlyfix/checks and frozen in the report. This one is generated per
 * request, so its wording can improve without touching stored rows.
 */

/**
 * What the service accepts for one fix. Structural so a DB row and a test
 * fixture both satisfy it without imports.
 */
export interface FixFindingInput {
  checkId: string
  category: string
  severity: string
  title: string
  description?: string | null
  evidence?: Record<string, unknown> | null
  remediation?: string | null
  /** The scanned site, so the prompt can name the project it applies to. */
  siteUrl?: string | null
}

export const MASTER_PROMPT = `You write fix prompts for ScanlyFix, a tool that scans websites and hands each finding to the developer's AI coding agent as a ready-to-run work order.

You will receive ONE finding from a scan: its check id, pillar, severity, title, description, the evidence observed at scan time, the engine's own remediation hint, and the site it was found on.

Write ONE prompt that the developer can paste into their AI coding agent (Cursor, Claude Code, Codex) to fix this issue in their codebase. The prompt is the entire output — no preamble, no explanation to the developer, no markdown headings outside the prompt itself.

Rules:
- Address the agent directly ("Add ...", "Replace ...", "Configure ...") and be concrete about files or places when the evidence names them.
- Use the evidence. If a header value, snippet or URL was observed, quote the relevant part so the agent verifies against reality rather than guessing.
- Give the exact change where you can: the header to set, the attribute to add, the config block, the pattern to replace with.
- Do not invent facts the finding does not support — no imagined frameworks, file paths or stack. If the evidence is thin, write the prompt so the agent first locates the right place, then applies the fix.
- Include a short verification step at the end (how to confirm the issue is gone).
- At most ~200 words. Plain text. Every sentence either locates the problem, fixes it, or verifies the fix.`

/**
 * The message array for one request. Pure, so the exact wording leaving this
 * service is asserted by a test rather than reviewed by hope.
 */
export function buildMessages(finding: FixFindingInput): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: MASTER_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        siteUrl: finding.siteUrl ?? null,
        checkId: finding.checkId,
        pillar: finding.category,
        severity: finding.severity,
        title: finding.title,
        description: finding.description ?? null,
        evidence: finding.evidence ?? null,
        remediationHint: finding.remediation ?? null,
      }),
    },
  ]
}

/** The parsed, validated body of a POST /fix request. */
export type ParsedFixRequest = { ok: true; finding: FixFindingInput } | { ok: false; error: string }

/**
 * Nothing arriving over the wire is trusted. The identity fields are required
 * — a fix prompt without a title or check id would be invented wholesale —
 * while the descriptive fields are optional because the engine marks them
 * nullable and the prompt says how to handle thin evidence.
 */
export function parseFixRequest(body: unknown): ParsedFixRequest {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Body must be a JSON object' }
  const finding = (body as { finding?: unknown }).finding
  if (typeof finding !== 'object' || finding === null) return { ok: false, error: 'finding is required' }

  const f = finding as Record<string, unknown>
  for (const key of ['checkId', 'category', 'severity', 'title'] as const) {
    if (typeof f[key] !== 'string' || (f[key] as string).trim() === '') {
      return { ok: false, error: `finding.${key} must be a non-empty string` }
    }
    if ((f[key] as string).length > 500) {
      return { ok: false, error: `finding.${key} is too long` }
    }
  }
  if (f.description !== undefined && f.description !== null && typeof f.description !== 'string') {
    return { ok: false, error: 'finding.description must be a string' }
  }
  if (f.remediation !== undefined && f.remediation !== null && typeof f.remediation !== 'string') {
    return { ok: false, error: 'finding.remediation must be a string' }
  }
  if (f.siteUrl !== undefined && f.siteUrl !== null && typeof f.siteUrl !== 'string') {
    return { ok: false, error: 'finding.siteUrl must be a string' }
  }
  if (f.evidence !== undefined && f.evidence !== null && (typeof f.evidence !== 'object' || Array.isArray(f.evidence))) {
    return { ok: false, error: 'finding.evidence must be an object' }
  }

  return {
    ok: true,
    finding: {
      checkId: f.checkId as string,
      category: f.category as string,
      severity: f.severity as string,
      title: f.title as string,
      description: (f.description as string | null | undefined) ?? null,
      remediation: (f.remediation as string | null | undefined) ?? null,
      siteUrl: (f.siteUrl as string | null | undefined) ?? null,
      evidence: (f.evidence as Record<string, unknown> | null | undefined) ?? null,
    },
  }
}
