import crypto from 'crypto'

/**
 * Computes the HMAC index used to look up an API-key row by its plaintext.
 *
 * Formula: `HMAC-SHA-256(payloadSecret).update(plaintext)` returned as hex.
 *
 * This matches the formula used by `@payloadcms/plugin-mcp` v0.3.x and by
 * Payload's own `useAPIKey: true` collection auth — keeping the storage shape
 * identical so v0.4 can authenticate rows created under v0.3.x without
 * re-issuing keys (R11).
 */
export function hashKey(plaintext: string, payloadSecret: string): string {
  return crypto.createHmac('sha256', payloadSecret).update(plaintext).digest('hex')
}

/**
 * Constant-time comparison of two hex-encoded hashes.
 * Returns false on any length mismatch without throwing.
 */
export function verifyHash(presented: string, stored: string): boolean {
  if (typeof presented !== 'string' || typeof stored !== 'string') return false
  if (presented.length !== stored.length) return false
  const a = Buffer.from(presented, 'hex')
  const b = Buffer.from(stored, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return crypto.timingSafeEqual(a, b)
}

const BEARER_PREFIX = 'Bearer '

/**
 * Extracts the plaintext token from an `Authorization: Bearer <token>` header.
 * Returns null for any other shape (missing, wrong scheme, empty token).
 */
export function extractBearerToken(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== 'string') return null
  if (!headerValue.startsWith(BEARER_PREFIX)) return null
  const token = headerValue.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : null
}
