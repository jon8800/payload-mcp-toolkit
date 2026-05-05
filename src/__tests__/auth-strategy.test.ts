import { describe, it, expect, vi } from 'vitest'
import {
  createBearerStrategy,
  translateLegacyScopes,
  AUTH_STRATEGY_NAME,
  getApiKeyContext,
} from '../auth-strategy'
import { hashKey } from '../hash'

const SECRET = 'test-payload-secret'

interface BuildPayloadOptions {
  rows: unknown[]
  findError?: Error
  updateError?: Error
}

function buildPayload(opts: BuildPayloadOptions) {
  const findMock = vi.fn(async () => {
    if (opts.findError) throw opts.findError
    return { docs: opts.rows, totalDocs: opts.rows.length }
  })
  const updateMock = vi.fn(async () => {
    if (opts.updateError) throw opts.updateError
    return {}
  })
  return {
    secret: SECRET,
    find: findMock,
    update: updateMock,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    findMock,
    updateMock,
  }
}

function makeHeaders(token: string | null): { get: (name: string) => string | null } {
  return {
    get: (name: string) => {
      if (name.toLowerCase() === 'authorization') return token === null ? null : `Bearer ${token}`
      return null
    },
  }
}

describe('translateLegacyScopes', () => {
  it('returns null for empty / non-object input', () => {
    expect(translateLegacyScopes(undefined)).toBeNull()
    expect(translateLegacyScopes(null)).toBeNull()
    expect(translateLegacyScopes('hi')).toBeNull()
    expect(translateLegacyScopes({})).toBeNull()
  })

  it('translates per-collection find/create/update/delete flags', () => {
    const out = translateLegacyScopes({
      posts: { find: true, create: true, update: false, delete: false },
      pages: { find: true, create: false, update: true, delete: true },
    })
    expect(out).toEqual({
      collections: {
        posts: ['read', 'create'],
        pages: ['read', 'update', 'delete'],
      },
    })
  })

  it('translates payload-mcp-tool checkboxes into tools.allow', () => {
    const out = translateLegacyScopes({
      'payload-mcp-tool': { findDocument: true, deleteDocument: false, searchContent: true },
    })
    expect(out).toEqual({ tools: { allow: ['findDocument', 'searchContent'] } })
  })

  it('skips collections with no enabled actions', () => {
    expect(
      translateLegacyScopes({ posts: { find: false, create: false } }),
    ).toBeNull()
  })

  it('ignores resource/prompt access groups (not modelled in scopes yet)', () => {
    const out = translateLegacyScopes({
      'payload-mcp-resource': { something: true },
      'payload-mcp-prompt': { another: true },
      posts: { find: true },
    })
    expect(out).toEqual({ collections: { posts: ['read'] } })
  })

  it('tolerates malformed entries silently', () => {
    const out = translateLegacyScopes({
      posts: 'broken',
      pages: { find: 'yes', create: 1 },
      blogs: { find: true },
    })
    expect(out).toEqual({ collections: { blogs: ['read'] } })
  })
})

describe('createBearerStrategy.authenticate', () => {
  const strategy = createBearerStrategy({
    collectionSlug: 'payload-mcp-api-keys',
    userCollection: 'users',
  })

  it('exports the documented strategy name', () => {
    expect(strategy.name).toBe(AUTH_STRATEGY_NAME)
  })

  it('returns null user when Authorization header is missing', async () => {
    const payload = buildPayload({ rows: [] })
    const result = await strategy.authenticate!({
      headers: makeHeaders(null) as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result).toEqual({ user: null })
    expect(payload.findMock).not.toHaveBeenCalled()
  })

  it('returns null user when scheme is not Bearer', async () => {
    const payload = buildPayload({ rows: [] })
    const result = await strategy.authenticate!({
      headers: { get: () => 'Basic abc' } as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result).toEqual({ user: null })
  })

  it('returns null user when no row matches the hashed token', async () => {
    const payload = buildPayload({ rows: [] })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result).toEqual({ user: null })
    expect(payload.findMock).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'payload-mcp-api-keys',
        where: { apiKeyIndex: { equals: hashKey('plaintext-key', SECRET) } },
      }),
    )
  })

  it('returns null user when the matched row is revoked', async () => {
    const payload = buildPayload({
      rows: [
        {
          id: 'k1',
          user: { id: 'u1', email: 'a@b.com' },
          scopes: null,
          revokedAt: '2025-01-01T00:00:00Z',
        },
      ],
    })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result).toEqual({ user: null })
  })

  it('returns null user when the matched row has expired', async () => {
    const payload = buildPayload({
      rows: [
        {
          id: 'k1',
          user: { id: 'u1' },
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result).toEqual({ user: null })
  })

  it('returns null user when the linked user is missing', async () => {
    const payload = buildPayload({ rows: [{ id: 'k1', user: null }] })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result).toEqual({ user: null })
  })

  it('hydrates the user, key context, and fires lastUsedAt write on a happy match', async () => {
    const payload = buildPayload({
      rows: [
        {
          id: 'k1',
          user: { id: 'u1', email: 'a@b.com' },
          scopes: { preset: 'admin' },
          keyPrefix: 'abc12345',
        },
      ],
    })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result.user).toMatchObject({
      id: 'u1',
      email: 'a@b.com',
      collection: 'users',
      _strategy: AUTH_STRATEGY_NAME,
      _mcpKey: { keyId: 'k1', keyPrefix: 'abc12345', scopes: { preset: 'admin' } },
    })
    // lastUsedAt update is fire-and-forget; allow microtask to schedule.
    await new Promise((r) => setImmediate(r))
    expect(payload.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'payload-mcp-api-keys',
        id: 'k1',
        data: expect.objectContaining({ lastUsedAt: expect.any(String) }),
      }),
    )
  })

  it('lazily translates legacy mcpAccessSettings when scopes is unset', async () => {
    const payload = buildPayload({
      rows: [
        {
          id: 'k2',
          user: { id: 'u2' },
          scopes: null,
          mcpAccessSettings: {
            posts: { find: true, create: true, update: false, delete: false },
          },
        },
      ],
    })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect((result.user as { _mcpKey: { scopes: unknown } })._mcpKey.scopes).toEqual({
      collections: { posts: ['read', 'create'] },
    })
    await new Promise((r) => setImmediate(r))
    // Two updates fired: scope migration + lastUsedAt.
    const scopeWrite = payload.updateMock.mock.calls.find(
      ([arg]) => (arg as { data: Record<string, unknown> }).data.scopes,
    )
    expect(scopeWrite).toBeTruthy()
  })

  it('does not block auth if find() throws', async () => {
    const payload = buildPayload({ rows: [], findError: new Error('db down') })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(result).toEqual({ user: null })
    expect(payload.logger.error).toHaveBeenCalled()
  })
})

describe('getApiKeyContext', () => {
  it('returns null for non-MCP requests', () => {
    expect(getApiKeyContext({ user: null } as never)).toBeNull()
    expect(getApiKeyContext({ user: { id: 'cookie-user' } } as never)).toBeNull()
  })

  it('returns the embedded key context when present', () => {
    const ctx = getApiKeyContext({
      user: {
        id: 'u1',
        _mcpKey: { keyId: 'k1', keyPrefix: 'abcd', scopes: { preset: 'editor' } },
      },
    } as never)
    expect(ctx).toEqual({ keyId: 'k1', keyPrefix: 'abcd', scopes: { preset: 'editor' } })
  })
})
