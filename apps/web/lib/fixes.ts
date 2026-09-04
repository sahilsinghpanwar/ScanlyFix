/**
 * The web side of the fix tier.
 *
 * The model lives in apps/fixes — its process holds the OPENROUTER_API_KEY and
 * the master prompt, and this file never sees either. What the web app
 * contributes is the part that must not be delegated: who may ask (a signed-in
 * reader, decided in the route, not here) and which finding they are asking
 * about (loaded from the database server-side, never taken from the request
 * body — a client-supplied finding text would let anyone generate fixes for
 * content their plan never unlocked).
 *
 * Gated exactly like the repo scanner: an unconfigured fix tier degrades to a
 * clear sentence from the Fix button, not a thrown 500.
 */

import 'server-only'
import { serverEnv } from './env.ts'

/** Enough of a finding for the model to write a real work order. */
export interface FixFinding {
  checkId: string
  category: string
  severity: string
  title: string
  description?: string | null
  evidence?: Record<string, unknown> | null
  remediation?: string | null
  siteUrl?: string | null
}

export type FixGeneration =
  | { ok: true; prompt: string }
  | { ok: false; reason: 'unconfigured' | 'busy' | 'upstream' | 'network' }

/**
 * What a failed generation becomes on the wire. Pure, so the contract the Fix
 * button codes against — which failures are retryable, which status each
 * reason carries — is asserted by a test rather than read out of a route.
 *
 * Only the transient reasons are retryable: busy, upstream and network can go
 * away on the next press. Unconfigured cannot — no retry reaches the env.
 */
export type FixFailureReason = 'unconfigured' | 'busy' | 'upstream' | 'network'

export function fixFailure(reason: FixFailureReason): {
  status: number
  body: { error: string; retryable: boolean }
} {
  const messages: Record<FixFailureReason, string> = {
    unconfigured:
      'Fix prompts are not configured on this deployment. Set SCANLYFIX_FIXES_URL and SCANLYFIX_FIXES_TOKEN.',
    busy: 'The fix writer is busy right now. Try again in a moment.',
    upstream: 'The model could not write a fix prompt. Try again.',
    network: 'Could not reach the fix writer. Check that it is running, then try again.',
  }
  return {
    status: reason === 'unconfigured' ? 503 : 502,
    body: {
      error: messages[reason],
      retryable: reason !== 'unconfigured',
    },
  }
}

/** A model call takes seconds; past this the retry button is better than a hung request. */
const TIMEOUT_MS = 50_000

export async function generateFix(finding: FixFinding): Promise<FixGeneration> {
  if (!serverEnv.fixesConfigured) return { ok: false, reason: 'unconfigured' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timer.unref()

  try {
    const response = await fetch(`${serverEnv.fixesUrl.replace(/\/+$/, '')}/fix`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serverEnv.fixesToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ finding }),
      signal: controller.signal,
    })

    if (response.ok) {
      const body = (await response.json()) as { prompt?: unknown }
      if (typeof body.prompt === 'string' && body.prompt.trim() !== '') {
        return { ok: true, prompt: body.prompt }
      }
      return { ok: false, reason: 'upstream' }
    }

    if (response.status === 503) return { ok: false, reason: 'busy' }
    return { ok: false, reason: 'upstream' }
  } catch {
    return { ok: false, reason: 'network' }
  } finally {
    clearTimeout(timer)
  }
}
