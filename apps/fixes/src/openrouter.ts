/**
 * The OpenRouter client.
 *
 * One job: hand the master prompt plus one finding to the model and bring back
 * the fix prompt text. Written against fetch with an AbortController deadline
 * rather than an SDK — OpenRouter is OpenAI-shaped, one endpoint, and a
 * dependency here would be more code than the call itself.
 */

import { buildMessages, type FixFindingInput } from './master-prompt.ts'

/** A slow model is worse than a failed one: the UI has a retry button, not a patience test. */
export const GENERATE_TIMEOUT_MS = 45_000

/** The free-tier model, tested live before wiring. Override with FIXES_MODEL. */
export const DEFAULT_MODEL = 'minimax/minimax-m3:free'

export interface ModelConfig {
  apiKey: string
  model: string
}

/** The error the HTTP surface maps to "our model upstream failed — retry". */
export class GenerationError extends Error {}

export interface GenerationResult {
  prompt: string
  model: string
  durationMs: number
}

/**
 * One completion. Retries are the CALLER's decision (the retry button is a
 * product behaviour, shown to a person) — a service-side retry doubles the
 * wait before the human sees the failure and doubles the spend when the
 * failure is a rejected key.
 */
export async function generateFixPrompt(finding: FixFindingInput, config: ModelConfig): Promise<GenerationResult> {
  const startedAt = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)
  timer.unref()

  let response: Response
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildMessages(finding),
        // A fix prompt is ~200 words; the ceiling exists so a runaway
        // completion becomes a failure, not a bill.
        max_tokens: 700,
        temperature: 0.2,
      }),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'unreachable'
    throw new GenerationError(`model ${reason}`)
  }
  clearTimeout(timer)

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error('openrouter refused', response.status, body.slice(0, 300))
    throw new GenerationError(`model returned ${response.status}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new GenerationError('model returned malformed JSON')
  }

  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new GenerationError('model returned an empty completion')
  }

  return {
    prompt: content.trim(),
    model: config.model,
    durationMs: Math.round(performance.now() - startedAt),
  }
}
