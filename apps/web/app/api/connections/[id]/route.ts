/**
 * DELETE /api/connections/[id] — revoke a deep-scan connection.
 *
 * The revoke path is a first-class feature, not an afterthought (the
 * integration plan builds it before any user-facing integration). For a
 * Supabase publishable key there is no provider-side revocation endpoint —
 * the key keeps working until the user rotates it in their dashboard — so
 * revoke here means: destroy our sealed copy of the key, mark the grant
 * revoked, and stop scanning with it. The response says exactly that so
 * nobody walks away believing the key itself was disabled.
 */

import { NextResponse } from 'next/server'
import { revokeConnection } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Sign in to manage your connections.' }, { status: 401 })
  }

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'Invalid connection id.' }, { status: 400 })
  }

  const revoked = await revokeConnection(id, viewer)
  if (!revoked) {
    // 404 rather than 403: the id reveals nothing about whether another
    // account owns it, and re-sending will not help.
    return NextResponse.json({ error: 'Connection not found.' }, { status: 404 })
  }

  return NextResponse.json({
    revoked: true,
    note: 'Our copy of the key was destroyed. The key itself stays valid until you rotate it in your Supabase dashboard.',
  })
}
