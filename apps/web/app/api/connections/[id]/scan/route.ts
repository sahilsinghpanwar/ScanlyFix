/**
 * POST /api/connections/[id]/scan — run a Level-1 (publishable-key) scan
 * over a connected Supabase project.
 *
 * This is the one place a credential is decrypted. The flow is the vault's
 * contract end to end: ownership-checked connection → sealed secret read
 * (which writes the credential_access_log audit row) → unwrap in memory →
 * run the checks → result persisted → plaintext never stored, returned, or
 * logged. A scan of someone else's connection id resolves to 404 at the
 * ownership check and never reaches the vault.
 */

import { NextResponse } from 'next/server'
import { getConnectionForViewer, getSecretForConnection, recordConnectionScan } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { serverEnv } from '@/lib/env.ts'
import { openSecret } from '@/lib/credentials-vault.ts'
import { scanSupabaseLevel1 } from '@/lib/supabase-connect.ts'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Sign in to scan a connection.' }, { status: 401 })
  }

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'Invalid connection id.' }, { status: 400 })
  }

  if (!serverEnv.connectionsConfigured) {
    return NextResponse.json(
      { error: 'Connections are not configured on this deployment yet (missing CONNECTION_ENCRYPTION_KEY).' },
      { status: 503 },
    )
  }

  const connection = await getConnectionForViewer(id, viewer)
  if (!connection) {
    return NextResponse.json({ error: 'Connection not found.' }, { status: 404 })
  }

  let key: string
  try {
    const sealed = await getSecretForConnection(id, viewer, 'scan')
    if (!sealed) {
      return NextResponse.json(
        { error: 'The sealed key is missing for this connection. Disconnect and connect the project again.' },
        { status: 409 },
      )
    }
    key = openSecret(serverEnv.connectionEncryptionKey, sealed)
  } catch (error) {
    // Tampering, a rotated CONNECTION_ENCRYPTION_KEY, or corruption — none of
    // which are recoverable by retrying, and none of which should leak why.
    console.error('[api/connections/scan] could not unwrap the credential', error)
    return NextResponse.json(
      { error: 'Could not read the stored credential for this connection. Disconnect and connect the project again.' },
      { status: 409 },
    )
  }

  try {
    const result = await scanSupabaseLevel1(connection.projectUrl, key)
    await recordConnectionScan(id, result)
    return NextResponse.json({ scan: result })
  } catch (error) {
    console.error('[api/connections/scan] scan pass failed', error)
    return NextResponse.json(
      { error: 'The scan pass failed. Please try again in a moment.' },
      { status: 500 },
    )
  }
}
