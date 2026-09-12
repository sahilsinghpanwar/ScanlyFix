/**
 * POST /api/connections — connect a deep-scan source.
 * GET  /api/connections — list the account's active connections.
 *
 * POST is the trust gate for the whole feature. In order it: authenticates
 * the session, refuses any provider this build does not implement, validates
 * the pasted URL down to a real *.supabase.co project host, REFUSES a
 * service-role key by name (Level 1 is publishable-key-only — see
 * lib/supabase-connect.ts), probes the project to confirm the pair actually
 * works, and only then seals the key into the vault and writes the grant.
 * Nothing sensitive is ever returned from this route.
 *
 * Requires CONNECTION_ENCRYPTION_KEY: a deployment that has not configured
 * the vault gets a clear 503, not a secret stored under a weaker scheme.
 */

import { NextResponse } from 'next/server'
import { listConnectionsForViewer, upsertConnection } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { serverEnv } from '@/lib/env.ts'
import { sealSecret } from '@/lib/credentials-vault.ts'
import { parseProjectUrl, probeProject, validateAnonKey } from '@/lib/supabase-connect.ts'

export const runtime = 'nodejs'

interface ConnectBody {
  provider?: unknown
  projectUrl?: unknown
  key?: unknown
}

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status })
}

export async function GET() {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return fail('Sign in to view your connections.', 401)
  }
  const connections = await listConnectionsForViewer(viewer)
  return NextResponse.json({ connections })
}

export async function POST(request: Request) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return fail('Sign in to connect a Supabase project. It takes a moment and keeps your reports.', 401)
  }

  let body: ConnectBody
  try {
    body = (await request.json()) as ConnectBody
  } catch {
    return fail('Expected a JSON body with projectUrl and key.', 400)
  }

  if (body.provider !== 'supabase') {
    return fail('Only Supabase connections are supported right now.', 400)
  }
  if (typeof body.projectUrl !== 'string' || typeof body.key !== 'string') {
    return fail('Expected a JSON body with projectUrl and key.', 400)
  }

  if (!serverEnv.connectionsConfigured) {
    return fail(
      'Connections are not configured on this deployment yet (missing CONNECTION_ENCRYPTION_KEY).',
      503,
    )
  }

  const parsed = parseProjectUrl(body.projectUrl)
  if (!parsed.ok) return fail(parsed.reason, 400)

  const keyCheck = validateAnonKey(body.key)
  if (!keyCheck.ok) return fail(keyCheck.reason, 400)

  const probe = await probeProject(parsed.projectUrl, body.key.trim())
  if (!probe.ok) return fail(probe.reason, 400)

  try {
    const secret = sealSecret(serverEnv.connectionEncryptionKey, body.key.trim())
    const connection = await upsertConnection(viewer, {
      provider: 'supabase',
      externalAccount: parsed.ref,
      projectUrl: parsed.projectUrl,
      scopes: ['anon_read'],
      secret,
    })
    if (!connection) return fail('Could not record the connection.', 500)
    return NextResponse.json({ connection })
  } catch (error) {
    console.error('[api/connections] could not seal + store the connection', error)
    return fail('Could not save the connection. Please try again in a moment.', 500)
  }
}
