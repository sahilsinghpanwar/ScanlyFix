import { createHmac, timingSafeEqual } from 'node:crypto';

export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Constant-time string equality — prevents timing-oracle attacks.
 */
export function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(b.length);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Verifies the incoming signature against the project secret.
 * Supports:
 * 1. Constant-time direct secret comparison (bearer token)
 * 2. HMAC-SHA256 of raw body
 * 3. HMAC-SHA256 of `${timestamp}.${rawBody}`
 */
export function verifySignature(
  incoming: string,
  secret: string,
  rawBody: string = '',
  timestamp?: string | null,
): boolean {
  if (!incoming || !secret) return false;

  // 1. Direct constant-time match
  if (secretsEqual(incoming, secret)) {
    return true;
  }

  // 2. HMAC-SHA256 over rawBody
  const hmacBody = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (secretsEqual(incoming, hmacBody) || secretsEqual(incoming, `sha256=${hmacBody}`)) {
    return true;
  }

  // 3. HMAC-SHA256 over `${timestamp}.${rawBody}`
  if (timestamp) {
    const hmacWithTs = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    if (secretsEqual(incoming, hmacWithTs) || secretsEqual(incoming, `sha256=${hmacWithTs}`)) {
      return true;
    }
  }

  return false;
}
