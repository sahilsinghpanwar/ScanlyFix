/**
 * Deep-scan connections: the explicit, scoped, revocable grants behind the
 * "connect Supabase" flow (more providers later).
 *
 * Every function here takes a Viewer, same access rule as the rest of the
 * package — a connection belongs to the account that made it, and a forged id
 * in a request body resolves to null rather than someone else's grant.
 *
 * The credential never passes through these functions in plaintext. The
 * caller hands in an already-sealed `{ encryptedDek, ciphertext }` pair
 * (envelope encryption — see apps/web/lib/credentials-vault.ts) and reads it
 * back only through getSecretForConnection, which is the ONE decrypt path and
 * the one that writes the audit row. The revoke path is deliberately as
 * first-class as the create path: hard-delete the vault record, mark the
 * grant revoked, keep the audit trail.
 */

import { and, desc, eq } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  connections,
  connectionSecrets,
  credentialAccessLog,
  type Connection,
  type ConnectionProvider,
  type ConnectionScanResult,
} from '../schema.ts'
import type { Viewer } from './viewer.ts'

export interface SealedSecret {
  encryptedDek: string
  ciphertext: string
}

export interface UpsertConnectionInput {
  provider: ConnectionProvider
  externalAccount: string
  projectUrl: string
  scopes: string[]
  secret: SealedSecret
}

/**
 * Record (or refresh) a connection the user just made.
 *
 * Reconnecting the same project updates the existing row — a connection is a
 * fact about a grant the user made, and stacking rows on every re-connect
 * would show the same project twice and leave the old secret readable. The
 * refresh also re-activates a revoked row: the user pressing "Connect" again
 * after revoking is an unambiguous re-grant.
 */
export async function upsertConnection(
  viewer: Viewer,
  input: UpsertConnectionInput,
): Promise<Connection | null> {
  if (viewer.kind !== 'user') return null

  const existing = await db.query.connections.findFirst({
    where: and(
      eq(connections.userId, viewer.userId),
      eq(connections.provider, input.provider),
      eq(connections.externalAccount, input.externalAccount),
    ),
  })

  if (existing) {
    const [updated] = await db
      .update(connections)
      .set({
        projectUrl: input.projectUrl,
        scopes: input.scopes,
        status: 'active',
        revokedAt: null,
      })
      .where(eq(connections.id, existing.id))
      .returning()
    if (updated) await replaceSecret(updated.id, input.secret)
    return updated ?? null
  }

  const inserted = await db
    .insert(connections)
    .values({
      userId: viewer.userId,
      provider: input.provider,
      externalAccount: input.externalAccount,
      projectUrl: input.projectUrl,
      scopes: input.scopes,
    })
    .returning()
  const connection = inserted[0]
  if (!connection) return null
  await replaceSecret(connection.id, input.secret)
  return connection
}

/** Swap the vault record for a fresh one. The old ciphertext is overwritten by the delete. */
async function replaceSecret(connectionId: string, secret: SealedSecret): Promise<void> {
  await db.delete(connectionSecrets).where(eq(connectionSecrets.connectionId, connectionId))
  await db.insert(connectionSecrets).values({
    connectionId,
    encryptedDek: secret.encryptedDek,
    ciphertext: secret.ciphertext,
  })
}

/** Active connections for an account, newest first. Revoked rows stay in the table for audit; the UI shows live grants. */
export async function listConnectionsForViewer(viewer: Viewer): Promise<Connection[]> {
  if (viewer.kind !== 'user') return []
  return db.query.connections.findMany({
    where: and(eq(connections.userId, viewer.userId), eq(connections.status, 'active')),
    orderBy: desc(connections.createdAt),
  })
}

/** One connection by row id, only if the viewer owns it and it is still active. */
export async function getConnectionForViewer(
  connectionId: string,
  viewer: Viewer,
): Promise<Connection | null> {
  if (viewer.kind !== 'user') return null
  const row = await db.query.connections.findFirst({
    where: and(
      eq(connections.id, connectionId),
      eq(connections.userId, viewer.userId),
      eq(connections.status, 'active'),
    ),
  })
  return row ?? null
}

/**
 * Read the sealed credential — the ONLY path that touches the vault, and the
 * one that logs every read. Decrypting happens at the call site, in memory,
 * at the moment of use; nothing here or anywhere else returns the plaintext
 * over the wire.
 */
export async function getSecretForConnection(
  connectionId: string,
  viewer: Viewer,
  purpose: string,
): Promise<SealedSecret | null> {
  const connection = await getConnectionForViewer(connectionId, viewer)
  if (!connection) return null
  const secret = await db.query.connectionSecrets.findFirst({
    where: eq(connectionSecrets.connectionId, connectionId),
  })
  if (!secret) return null
  await db.insert(credentialAccessLog).values({ connectionId, purpose })
  return { encryptedDek: secret.encryptedDek, ciphertext: secret.ciphertext }
}

/**
 * Revoke a connection: hard-delete the vault record and mark the grant
 * revoked. The anon key a Supabase project publishes cannot be invalidated
 * from our side — rotation happens in the user's dashboard — so revocation
 * here means "we destroy our copy and stop scanning with it", and the copy
 * says exactly that.
 */
export async function revokeConnection(connectionId: string, viewer: Viewer): Promise<boolean> {
  const connection = await getConnectionForViewer(connectionId, viewer)
  if (!connection) return false
  await db.delete(connectionSecrets).where(eq(connectionSecrets.connectionId, connectionId))
  await db
    .update(connections)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(connections.id, connectionId))
  return true
}

/** Persist the result of a scan pass over this connection. */
export async function recordConnectionScan(
  connectionId: string,
  result: ConnectionScanResult,
): Promise<void> {
  await db
    .update(connections)
    .set({ lastScan: result, lastScannedAt: new Date(), status: 'active' })
    .where(eq(connections.id, connectionId))
}
