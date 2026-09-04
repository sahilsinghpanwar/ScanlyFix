/**
 * The fix tier's HTTP surface.
 *
 * One endpoint, POST /fix, which takes one finding and returns the prompt that
 * fixes it, written by the model. The web backend calls it; nothing else
 * should be able to.
 *
 * ## Fail closed, deliberately and loudly
 *
 * This service holds the OPENROUTER_API_KEY and spends real money per call.
 * SCANLYFIX_FIXES_TOKEN is therefore REQUIRED: with no token configured this
 * process refuses to start rather than listening as a free model proxy for
 * whoever finds the port. There is no development escape hatch, because the
 * development escape hatch is what ends up deployed.
 *
 * Written against node:http rather than a framework — the whole surface is one
 * route, one auth check and a JSON body, and a framework here would be more
 * dependency than code.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { parseFixRequest } from './master-prompt.ts'
import { generateFixPrompt, GenerationError, DEFAULT_MODEL, type ModelConfig } from './openrouter.ts'

const PORT = Number(process.env['PORT'] ?? 8082)
const TOKEN = process.env['SCANLYFIX_FIXES_TOKEN'] ?? ''
const API_KEY = process.env['OPENROUTER_API_KEY'] ?? ''
const MODEL = process.env['FIXES_MODEL'] ?? DEFAULT_MODEL

/**
 * A model call is seconds, not milliseconds, and the free tier throttles.
 * Four at a time keeps bursts from stacking a minute of queue in front of the
 * first caller; beyond that the caller gets a clean 503 and its retry button
 * does the backoff.
 */
const MAX_IN_FLIGHT = 4
const MAX_BODY_BYTES = 16 * 1024

interface FixRequest {
  finding?: unknown
}

if (!TOKEN) {
  console.error(
    'SCANLYFIX_FIXES_TOKEN is not set. This service spends model credits on every call it accepts;\n' +
      'without a shared secret anyone who can reach the port can spend them. Refusing to start.',
  )
  process.exit(1)
}

if (!API_KEY) {
  console.error(
    'OPENROUTER_API_KEY is not set. Without it no fix prompt can be generated and every call\n' +
      'would fail downstream. Refusing to start.',
  )
  process.exit(1)
}

const config: ModelConfig = { apiKey: API_KEY, model: MODEL }

let inFlight = 0

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error('unhandled', error)
    send(response, 500, { error: 'Internal error' })
  })
})

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    return send(response, 200, { ok: true, model: MODEL, inFlight })
  }
  if (request.method !== 'POST' || request.url !== '/fix') {
    return send(response, 404, { error: 'Not found' })
  }
  if (!authorized(request)) {
    // No detail: an unauthenticated caller learns nothing about why.
    return send(response, 401, { error: 'Unauthorized' })
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    response.setHeader('retry-after', '10')
    return send(response, 503, { error: 'Busy' })
  }

  let body: FixRequest
  try {
    body = JSON.parse(await readBody(request)) as FixRequest
  } catch {
    return send(response, 400, { error: 'Body must be JSON' })
  }

  const parsed = parseFixRequest(body)
  if (!parsed.ok) return send(response, 400, { error: parsed.error })

  inFlight += 1
  try {
    const result = await generateFixPrompt(parsed.finding, config)
    send(response, 200, { prompt: result.prompt, model: result.model, durationMs: result.durationMs })
  } catch (error) {
    if (error instanceof GenerationError) {
      console.error('generation failed:', error.message)
      send(response, 502, { error: 'The model could not write a fix prompt. Try again.' })
    } else {
      console.error('fix failed', error)
      send(response, 502, { error: 'Could not generate the fix prompt' })
    }
  } finally {
    inFlight -= 1
  }
}

/**
 * Constant-time comparison. A token check that returns early on the first
 * wrong byte leaks the token one character at a time to anyone patient enough
 * to measure the difference.
 */
function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(presented)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}

server.listen(PORT, () => console.log(`scanlyfix fixes listening on :${PORT} (model: ${MODEL})`))
