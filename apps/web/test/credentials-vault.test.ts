import { describe, expect, it } from 'vitest'
import { assertRootKey, openSecret, sealSecret } from '@/lib/credentials-vault.ts'

const ROOT_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
const OTHER_ROOT_KEY = Buffer.from('ffffffffffffffffffffffffffffffff').toString('base64')

describe('sealSecret / openSecret', () => {
  it('round-trips a secret through both envelope layers', () => {
    const sealed = sealSecret(ROOT_KEY, 'sb_publishable_test-key-value')
    expect(sealed.ciphertext).not.toContain('sb_publishable')
    expect(sealed.encryptedDek).not.toContain('sb_publishable')
    expect(openSecret(ROOT_KEY, sealed)).toBe('sb_publishable_test-key-value')
  })

  it('uses a fresh data key per seal, so two seals of the same secret differ', () => {
    const first = sealSecret(ROOT_KEY, 'same-secret')
    const second = sealSecret(ROOT_KEY, 'same-secret')
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.encryptedDek).not.toBe(second.encryptedDek)
    expect(openSecret(ROOT_KEY, first)).toBe(openSecret(ROOT_KEY, second))
  })

  it('refuses to decrypt under a different root key', () => {
    const sealed = sealSecret(ROOT_KEY, 'secret')
    expect(() => openSecret(OTHER_ROOT_KEY, sealed)).toThrow()
  })

  it('detects a tampered ciphertext (GCM auth tag)', () => {
    const sealed = sealSecret(ROOT_KEY, 'secret')
    const raw = Buffer.from(sealed.ciphertext, 'base64')
    const lastByte = raw.length - 1
    raw[lastByte] = (raw[lastByte] ?? 0) ^ 0x01
    expect(() => openSecret(ROOT_KEY, { ...sealed, ciphertext: raw.toString('base64') })).toThrow()
  })

  it('detects a tampered data key', () => {
    const sealed = sealSecret(ROOT_KEY, 'secret')
    const raw = Buffer.from(sealed.encryptedDek, 'base64')
    const lastByte = raw.length - 1
    raw[lastByte] = (raw[lastByte] ?? 0) ^ 0x01
    expect(() => openSecret(ROOT_KEY, { ...sealed, encryptedDek: raw.toString('base64') })).toThrow()
  })
})

describe('assertRootKey', () => {
  it('accepts a 32-byte base64 key', () => {
    expect(() => assertRootKey(ROOT_KEY)).not.toThrow()
  })

  it('refuses a key that does not decode to 32 bytes, with the generate command', () => {
    try {
      assertRootKey(Buffer.from('too-short').toString('base64'))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('openssl rand -base64 32')
    }
  })
})
