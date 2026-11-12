import { describe, it, expect, vi } from 'vitest'
import {
  createBearerStrategy,
  AUTH_STRATEGY_NAME,
  getApiKeyContext,
  composeScopes,
  _resetLegacyWarnsForTests,
} from '../auth-strategy.js'
import { hashKey } from '../hash.js'

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

describe('composeScopes', () => {
  const baseRow = { id: 'k', user: { id: 'u' } }

  it('returns null when no typed fields are populated (= full access)', () => {
    expect(composeScopes({ ...baseRow })).toBeNull()
  })

  it('builds KeyScopes from typed fields when populated', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'editor',
      toolDeny: ['safeDelete'],
    })
    expect(out).toEqual({
      preset: 'editor',
      tools: { deny: ['safeDelete'] },
    })
  })

  it('treats preset === "custom" as a UI sentinel and drops it from KeyScopes', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      collectionScopes: [{ slug: 'posts', actions: ['read', 'create'] }],
    })
    expect(out).toEqual({
      collections: { posts: ['read', 'create'] },
    })
  })

  it('returns a deny-all sentinel when preset === "custom" with no overrides', () => {
    // Fail-closed contract: a freshly-created Custom key with empty
    // collectionScopes / toolAllow / toolDeny denies every dispatch instead
    // of falling through to the "no scopes set = full access" guard.
    expect(composeScopes({ ...baseRow, preset: 'custom' })).toEqual({
      collections: {},
      globals: {},
      tools: { allow: [] },
    })
  })

  it('honours partial custom overrides (only toolAllow) without injecting deny-all', () => {
    // Verifies the sentinel only fires when ALL override fields are empty.
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      toolAllow: ['searchContent'],
    })
    expect(out).toEqual({ tools: { allow: ['searchContent'] } })
  })

  it('preserves an empty actions array as explicit-deny-all on a listed collection', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      collectionScopes: [{ slug: 'posts', actions: [] }],
    })
    expect(out).toEqual({ collections: { posts: [] } })
  })

  it('filters invalid action values out of collectionScopes', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      collectionScopes: [
        { slug: 'posts', actions: ['read', 'bogus', 1, 'update'] as unknown as string[] },
      ],
    })
    expect(out).toEqual({ collections: { posts: ['read', 'update'] } })
  })

  // ─── Globals (U9) ────────────────────────────────────────────────

  it('maps globalScopes to KeyScopes.globals', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      globalScopes: [
        { slug: 'siteSettings', actions: ['read', 'update'] },
        { slug: 'footer', actions: ['read'] },
      ],
    })
    expect(out).toEqual({
      globals: { siteSettings: ['read', 'update'], footer: ['read'] },
    })
  })

  it('filters invalid global action values', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      globalScopes: [
        { slug: 'siteSettings', actions: ['read', 'create', 'delete', 'update'] as unknown as string[] },
      ],
    })
    // Only read/update are valid on globals — create/delete dropped.
    expect(out).toEqual({ globals: { siteSettings: ['read', 'update'] } })
  })

  it('preset admin + globalScopes: null produces a preset-only KeyScopes (legacy v0.5 row)', () => {
    const out = composeScopes({ ...baseRow, preset: 'admin', globalScopes: null })
    expect(out).toEqual({ preset: 'admin' })
  })

  it('preset editor + globalScopes: [] is ignored — empty arrays under non-Custom presets carry no opinion', () => {
    // Under non-Custom presets the override fields are hidden in the admin
    // UI and Payload's hasMany / relational reads return `[]` for unset
    // relations. Empty arrays would otherwise turn every preset key into a
    // deny-all key once it round-trips through the DB. The explicit-empty
    // deny-all semantic is reserved for the Custom preset, where the
    // override fields are visible and meaningful.
    const out = composeScopes({ ...baseRow, preset: 'editor', globalScopes: [] })
    expect(out).toEqual({ preset: 'editor' })
  })

  it('preset editor + collectionScopes: [] is ignored under non-Custom presets', () => {
    const out = composeScopes({ ...baseRow, preset: 'editor', collectionScopes: [] })
    expect(out).toEqual({ preset: 'editor' })
  })

  it('preset admin + toolAllow: [] is ignored (Payload hasMany default does not deny-all under preset modes)', () => {
    const out = composeScopes({ ...baseRow, preset: 'admin', toolAllow: [] })
    expect(out).toEqual({ preset: 'admin' })
  })

  it('preset editor + populated globalScopes still applies as a layered narrowing', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'editor',
      globalScopes: [{ slug: 'siteSettings', actions: ['read'] }],
    })
    expect(out).toEqual({ preset: 'editor', globals: { siteSettings: ['read'] } })
  })

  it('emits a one-time warn when a non-Custom row carries populated override arrays (legacy v0.7.0 row audit nudge)', () => {
    _resetLegacyWarnsForTests()
    const logger = { warn: vi.fn() }
    composeScopes(
      {
        ...baseRow,
        preset: 'admin',
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
      },
      logger,
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mcp.auth.legacy_non_custom_override' }),
      expect.stringContaining('non-Custom preset (admin)'),
    )
    // Second row with the same shape does not double-log within the process.
    composeScopes(
      {
        ...baseRow,
        preset: 'editor',
        toolAllow: ['findDocument'],
      },
      logger,
    )
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('preset admin + populated toolDeny still emits the deny axis (deny-lists are never gated by the empty-array rule)', () => {
    // toolDeny is asymmetric to toolAllow: a populated deny list expresses
    // intent independently of the preset, and an empty deny carries no
    // entries (dropped). The empty-array-under-non-Custom-ignored rule
    // applies only to allow-shaped axes (collectionScopes, globalScopes,
    // toolAllow); toolDeny is unconditional.
    const out = composeScopes({ ...baseRow, preset: 'admin', toolDeny: ['safeDelete'] })
    expect(out).toEqual({ preset: 'admin', tools: { deny: ['safeDelete'] } })
  })

  it('preset custom + populated collectionScopes + toolAllow: [] means no tool restriction', () => {
    // Payload 4 reads an empty hasMany select as [] even when the on-write
    // hook stored null. The toolAllow description promises this case
    // "collapses to \"no tool restriction\"", so the read must agree.
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      collectionScopes: [{ slug: 'posts', actions: ['read'] }],
      toolAllow: [],
    })
    expect(out).toEqual({ collections: { posts: ['read'] } })
  })

  // Scenario table across the custom-preset cells this rule crosses
  // (collectionScopes × globalScopes × toolAllow, toolDeny fixed at []).
  // Every row is the shape Payload 4 hands back on read.
  const entry = { slug: 'posts', actions: ['read'] }
  const gEntry = { slug: 'siteSettings', actions: ['read'] }
  it.each([
    ['null', 'null', '[]', { tools: { allow: [] } }],
    ['[]', 'null', '[]', { collections: {}, tools: { allow: [] } }],
    ['[]', '[]', '[]', { collections: {}, globals: {}, tools: { allow: [] } }],
    ['[entry]', 'null', '[]', { collections: { posts: ['read'] } }],
    ['[entry]', '[]', '[]', { collections: { posts: ['read'] }, globals: {} }],
    ['null', '[entry]', '[]', { globals: { siteSettings: ['read'] } }],
    ['[]', '[entry]', '[]', { collections: {}, globals: { siteSettings: ['read'] } }],
    ['[entry]', 'null', '[entry]', { collections: { posts: ['read'] }, tools: { allow: ['findDocument'] } }],
    ['null', 'null', '[entry]', { tools: { allow: ['findDocument'] } }],
    ['[entry]', 'null', 'null', { collections: { posts: ['read'] } }],
  ])('custom × collectionScopes %s × globalScopes %s × toolAllow %s', (cs, gs, ta, expected) => {
    const pick = (v: string, e: unknown) => (v === 'null' ? null : v === '[]' ? [] : [e])
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      collectionScopes: pick(cs, entry) as never,
      globalScopes: pick(gs, gEntry) as never,
      toolAllow: pick(ta, 'findDocument') as never,
      toolDeny: [],
    })
    expect(out).toEqual(expected)
  })

  it.each(['admin', 'editor', 'read-only'] as const)(
    'preset %s + [entry] collectionScopes + toolAllow: [] narrows by collection only',
    (preset) => {
      const out = composeScopes({ ...baseRow, preset, collectionScopes: [entry] as never, toolAllow: [], toolDeny: [] })
      expect(out).toEqual({ preset, collections: { posts: ['read'] } })
    },
  )

  it('explicit toolDeny: [] carries no entries and emits nothing', () => {
    // toolDeny is a deny-list — an empty array has nothing to deny, so the
    // axis is dropped rather than emitting `tools.deny: []`.
    const out = composeScopes({ ...baseRow, preset: 'editor', toolDeny: [] })
    expect(out).toEqual({ preset: 'editor' })
  })

  it('widened deny-all sentinel: empty everywhere produces both maps and tools.allow=[]', () => {
    expect(
      composeScopes({
        ...baseRow,
        preset: 'custom',
        collectionScopes: [],
        globalScopes: [],
        toolAllow: [],
        toolDeny: [],
      }),
    ).toEqual({ collections: {}, globals: {}, tools: { allow: [] } })
  })

  it('partial custom override on the globals axis does NOT fire the sentinel', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      globalScopes: [{ slug: 'siteSettings', actions: ['read'] }],
    })
    expect(out).toEqual({ globals: { siteSettings: ['read'] } })
  })

  it('combines toolAllow and toolDeny into tools.allow / tools.deny', () => {
    const out = composeScopes({
      ...baseRow,
      toolAllow: ['findDocument', 'searchContent'],
      toolDeny: ['deleteDocument'],
    })
    expect(out).toEqual({
      tools: { allow: ['findDocument', 'searchContent'], deny: ['deleteDocument'] },
    })
  })

  // ─── Legacy row-shape fallback (pre-0.6 → 0.6 transition) ─────────
  //
  // The {slug, actions} normalization landed mid-0.6 — pre-existing
  // {collection, actions} / {global, actions} rows are tolerated for one
  // release so locally-tested 0.6 fixtures keep authenticating. The
  // fallback is removed in v0.7.

  it('falls back to row.collection when row.slug is missing (legacy collectionScopes)', () => {
    const warn = vi.fn()
    const out = composeScopes(
      {
        ...baseRow,
        preset: 'custom',
        collectionScopes: [{ collection: 'posts', actions: ['read'] } as never],
      },
      { warn },
    )
    expect(out).toEqual({ collections: { posts: ['read'] } })
  })

  it('falls back to row.global when row.slug is missing (legacy globalScopes)', () => {
    const warn = vi.fn()
    const out = composeScopes(
      {
        ...baseRow,
        preset: 'custom',
        globalScopes: [{ global: 'siteSettings', actions: ['read'] } as never],
      },
      { warn },
    )
    expect(out).toEqual({ globals: { siteSettings: ['read'] } })
  })

  it('prefers row.slug over the legacy row.collection key when both are set', () => {
    const out = composeScopes({
      ...baseRow,
      preset: 'custom',
      collectionScopes: [
        { slug: 'posts', collection: 'stale-slug', actions: ['read'] } as never,
      ],
    })
    expect(out).toEqual({ collections: { posts: ['read'] } })
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

  it('matches the index under every secret in the Payload 4 keyring, active first', async () => {
    const payload = Object.assign(buildPayload({ rows: [] }), {
      encryptionKeyring: { all: [{ legacyKey: 'active-key' }, { legacyKey: 'previous-key' }] },
    })
    await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(payload.findMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { apiKeyIndex: { in: [hashKey('plaintext-key', 'active-key'), hashKey('plaintext-key', 'previous-key')] } },
      }),
    )
  })

  it('uses one equals lookup when the keyring holds a single secret', async () => {
    const payload = Object.assign(buildPayload({ rows: [] }), {
      encryptionKeyring: { all: [{ legacyKey: 'only-key' }] },
    })
    await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(payload.findMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { apiKeyIndex: { equals: hashKey('plaintext-key', 'only-key') } } }),
    )
  })

  it('falls back to payload.secret when the keyring is empty', async () => {
    const payload = Object.assign(buildPayload({ rows: [] }), { encryptionKeyring: { all: [] } })
    await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect(payload.findMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { apiKeyIndex: { equals: hashKey('plaintext-key', SECRET) } } }),
    )
  })

  it('returns null user when the matched row is revoked', async () => {
    const payload = buildPayload({
      rows: [
        {
          id: 'k1',
          user: { id: 'u1', email: 'a@b.com' },
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
          preset: 'admin',
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

  it('hydrates _mcpKey.scopes from typed fields with collectionScopes + toolDeny', async () => {
    const payload = buildPayload({
      rows: [
        {
          id: 'k3',
          user: { id: 'u3' },
          keyPrefix: 'deadbeef',
          preset: 'custom',
          collectionScopes: [{ slug: 'posts', actions: ['read', 'update'] }],
          toolDeny: ['safeDelete'],
        },
      ],
    })
    const result = await strategy.authenticate!({
      headers: makeHeaders('plaintext-key') as unknown as Headers,
      payload: payload as never,
    } as never)
    expect((result.user as { _mcpKey: { scopes: unknown } })._mcpKey.scopes).toEqual({
      collections: { posts: ['read', 'update'] },
      tools: { deny: ['safeDelete'] },
    })
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
