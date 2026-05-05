import crypto from 'crypto'
import { describe, it, expect } from 'vitest'
import { hashKey, verifyHash, extractBearerToken } from '../hash'

describe('hashKey', () => {
  it('returns 64-char hex output', () => {
    const out = hashKey('mcp_live_abcdefghijklmnopqrstuv', 'super-secret')
    expect(out).toMatch(/^[a-f0-9]{64}$/)
  })

  it('matches the upstream/Payload-internal HMAC formula so v0.3.x rows still authenticate', () => {
    const plaintext = 'some-existing-api-key'
    const secret = 'shared-secret'
    const expected = crypto.createHmac('sha256', secret).update(plaintext).digest('hex')
    expect(hashKey(plaintext, secret)).toBe(expected)
  })

  it('is deterministic for the same inputs', () => {
    expect(hashKey('a', 's')).toBe(hashKey('a', 's'))
  })

  it('produces different outputs for different secrets', () => {
    expect(hashKey('a', 's1')).not.toBe(hashKey('a', 's2'))
  })
})

describe('verifyHash', () => {
  it('returns true for matching hashes', () => {
    const a = hashKey('x', 's')
    expect(verifyHash(a, a)).toBe(true)
  })

  it('returns false for non-matching hashes', () => {
    expect(verifyHash(hashKey('x', 's'), hashKey('y', 's'))).toBe(false)
  })

  it('returns false on length mismatch without throwing', () => {
    expect(verifyHash('a', 'ab')).toBe(false)
  })

  it('returns false on non-string input', () => {
    expect(verifyHash(undefined as unknown as string, 'ab')).toBe(false)
    expect(verifyHash('ab', null as unknown as string)).toBe(false)
  })

  it('returns false on empty strings', () => {
    expect(verifyHash('', '')).toBe(false)
  })
})

describe('extractBearerToken', () => {
  it('returns the trimmed token for a valid Bearer header', () => {
    expect(extractBearerToken('Bearer abc-123')).toBe('abc-123')
    expect(extractBearerToken('Bearer   spaced-token  ')).toBe('spaced-token')
  })

  it('returns null for non-Bearer schemes', () => {
    expect(extractBearerToken('Basic abc')).toBeNull()
    expect(extractBearerToken('users API-Key abc')).toBeNull()
  })

  it('returns null for missing or empty header values', () => {
    expect(extractBearerToken(undefined)).toBeNull()
    expect(extractBearerToken(null)).toBeNull()
    expect(extractBearerToken('')).toBeNull()
    expect(extractBearerToken('Bearer ')).toBeNull()
  })
})
