/**
 * The credential vault's crypto: envelope encryption, no dependencies.
 *
 * Every deep-scan connection hands us a secret (a Supabase publishable key
 * today; more sensitive grants later). None of them ever sit in the database
 * in plaintext or under a single fixed key — the shape is the standard
 * envelope:
 *
 *   plaintext ──AES-256-GCM── data key (random, per record)
 *   data key  ──AES-256-GCM── root key (deployment environment)
 *
 * Two ciphertexts go to the database: the sealed secret and its wrapped data
 * key. Decrypting needs the root key, which lives only in the deployment's
 * environment (CONNECTION_ENCRYPTION_KEY) and is read exclusively by the scan
 * route at the moment of use. A dump of the database therefore contains no
 * usable credential — this is the same trust property KMS envelope encryption
 * buys, minus the KMS; swapping the root-key source for a KMS call later
 * touches exactly one function (resolveRootKey's caller) and nothing else.
 *
 * Kept free of 'server-only' and of process.env on purpose: the functions take
 * the root key as an argument, which makes the crypto unit-testable without
 * standing up serverEnv, and keeps every policy decision (is the key set? how
 * strong?) at the call sites that own it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const AES = 'aes-256-gcm'
const IV_BYTES = 12 // 96-bit IV: the GCM recommendation, large enough to be random-per-message
const KEY_BYTES = 32
/** iv | auth-tag | ciphertext, base64 — one string per layer so the DB row stays flat. */
const LAYOUT = 'iv(12) | tag(16) | ciphertext, base64'

export interface SealedSecret {
  encryptedDek: string
  ciphertext: string
}

/** A root key that is not exactly 32 bytes of base64 is a misconfiguration, not a fallback. */
export function assertRootKey(rootKey: string): Buffer {
  let decoded: Buffer
  try {
    decoded = Buffer.from(rootKey, 'base64')
  } catch {
    throw new Error('CONNECTION_ENCRYPTION_KEY is not valid base64.')
  }
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      'CONNECTION_ENCRYPTION_KEY must decode to exactly 32 bytes. ' +
        'Generate one with: openssl rand -base64 32',
    )
  }
  return decoded
}

function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(AES, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

function unseal(key: Buffer, packed: string): Buffer {
  const raw = Buffer.from(packed, 'base64')
  if (raw.length <= IV_BYTES + 16) throw new Error('Sealed value is truncated or corrupt.')
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + 16)
  const ciphertext = raw.subarray(IV_BYTES + 16)
  const decipher = createDecipheriv(AES, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Encrypt `plaintext` under a fresh per-record data key, wrapped by `rootKey`. */
export function sealSecret(rootKey: string, plaintext: string): SealedSecret {
  const root = assertRootKey(rootKey)
  const dataKey = randomBytes(KEY_BYTES)
  return {
    encryptedDek: seal(root, dataKey),
    ciphertext: seal(dataKey, Buffer.from(plaintext, 'utf8')),
  }
}

/** The inverse. Throws when either layer fails its auth tag — a tampered or foreign record never decrypts silently. */
export function openSecret(rootKey: string, sealed: SealedSecret): string {
  const root = assertRootKey(rootKey)
  const dataKey = unseal(root, sealed.encryptedDek)
  return unseal(dataKey, sealed.ciphertext).toString('utf8')
}
