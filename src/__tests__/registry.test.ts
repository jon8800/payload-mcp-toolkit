import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  ACCOUNT_LEVEL_TOOLS,
  assertScopeAllows,
  assertScopeRegistryInvariant,
  createInitializeServer,
  resolveResourceKind,
  TOOL_TO_ACTION,
  TOOL_TO_GLOBAL_ACTION,
  type ToolFactoryOutput,
} from '../registry'

describe('assertScopeAllows', () => {
  it('grants full access when scopes is null/undefined or empty', () => {
    expect(assertScopeAllows(null, 'createDocument', 'posts').allowed).toBe(true)
    expect(assertScopeAllows(undefined, 'deleteDocument', 'posts').allowed).toBe(true)
    expect(assertScopeAllows({}, 'createDocument', 'posts').allowed).toBe(true)
  })

  it('denies every dispatch path under the deny-all sentinel from composeScopes', () => {
    // composeScopes returns this shape for "preset = custom, no overrides".
    // The registry must reject all three dispatch shapes:
    //   - collection-keyed tools (createDocument, etc.)
    //   - account-wide tools (searchContent, uploadMedia)
    //   - delete tools
    const denyAll = { collections: {}, tools: { allow: [] } }
    expect(assertScopeAllows(denyAll, 'createDocument', 'posts').allowed).toBe(false)
    expect(assertScopeAllows(denyAll, 'findDocument', 'posts').allowed).toBe(false)
    expect(assertScopeAllows(denyAll, 'deleteDocument', 'posts').allowed).toBe(false)
    expect(assertScopeAllows(denyAll, 'searchContent', undefined).allowed).toBe(false)
    expect(assertScopeAllows(denyAll, 'uploadMedia', undefined).allowed).toBe(false)
  })

  it('respects the read-only preset for write tools', () => {
    const decision = assertScopeAllows({ preset: 'read-only' }, 'createDocument', 'posts')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/create/)
  })

  it('respects the editor preset (no deletes)', () => {
    expect(assertScopeAllows({ preset: 'editor' }, 'createDocument', 'posts').allowed).toBe(true)
    expect(assertScopeAllows({ preset: 'editor' }, 'deleteDocument', 'posts').allowed).toBe(false)
    expect(assertScopeAllows({ preset: 'editor' }, 'safeDelete', 'posts').allowed).toBe(false)
  })

  it('admin preset allows everything', () => {
    expect(assertScopeAllows({ preset: 'admin' }, 'deleteDocument', 'posts').allowed).toBe(true)
  })

  it('per-collection override replaces preset for that slug', () => {
    const decision = assertScopeAllows(
      {
        preset: 'admin',
        collections: { posts: ['read'] },
      },
      'updateDocument',
      'posts',
    )
    expect(decision.allowed).toBe(false)
  })

  it('treats scopes.collections as a whitelist — unlisted collections are denied', () => {
    const scopes = { collections: { posts: ['read', 'update'] as never } }
    expect(assertScopeAllows(scopes, 'updateDocument', 'pages').allowed).toBe(false)
    expect(assertScopeAllows(scopes, 'deleteDocument', 'categories').allowed).toBe(false)
    // Listed collection still works for allowed actions
    expect(assertScopeAllows(scopes, 'updateDocument', 'posts').allowed).toBe(true)
  })

  it('blocks no-collection tools at the preset action level (read-only cannot uploadMedia)', () => {
    const decision = assertScopeAllows({ preset: 'read-only' }, 'uploadMedia', undefined)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/create/)
  })

  it('allows no-collection read tools under read-only preset', () => {
    expect(assertScopeAllows({ preset: 'read-only' }, 'searchContent', undefined).allowed).toBe(
      true,
    )
    expect(assertScopeAllows({ preset: 'read-only' }, 'resolveReference', undefined).allowed).toBe(
      true,
    )
  })

  it('denies no-collection tools when key is collection-scoped only (no preset)', () => {
    const scopes = { collections: { posts: ['read'] as never } }
    expect(assertScopeAllows(scopes, 'searchContent', undefined).allowed).toBe(false)
    expect(assertScopeAllows(scopes, 'uploadMedia', undefined).allowed).toBe(false)
  })

  it('tools.deny blocks an explicitly listed tool', () => {
    const decision = assertScopeAllows(
      { preset: 'admin', tools: { deny: ['safeDelete'] } },
      'safeDelete',
      'posts',
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/denied/)
  })

  it('tools.allow restricts to listed tools only', () => {
    const decision = assertScopeAllows(
      { tools: { allow: ['findDocument'] } },
      'searchContent',
      undefined,
    )
    expect(decision.allowed).toBe(false)
  })

  it('skips collection check when the tool has no collection arg', () => {
    expect(
      assertScopeAllows({ preset: 'read-only' }, 'searchContent', undefined).allowed,
    ).toBe(true)
  })
})

// ─── Globals scope routing (U6) ──────────────────────────────────────

describe('assertScopeAllows — globals', () => {
  it('read-only preset allows findGlobal', () => {
    expect(
      assertScopeAllows({ preset: 'read-only' }, 'findGlobal', 'siteSettings').allowed,
    ).toBe(true)
  })

  it('editor preset allows findGlobal (read still permitted on globals)', () => {
    expect(
      assertScopeAllows({ preset: 'editor' }, 'findGlobal', 'siteSettings').allowed,
    ).toBe(true)
  })

  it('editor preset DENIES updateGlobal (asymmetric — global writes need admin)', () => {
    const decision = assertScopeAllows({ preset: 'editor' }, 'updateGlobal', 'siteSettings')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/global "siteSettings"/)
    expect(decision.reason).toMatch(/preset/)
  })

  it('admin preset allows updateGlobal', () => {
    expect(
      assertScopeAllows({ preset: 'admin' }, 'updateGlobal', 'siteSettings').allowed,
    ).toBe(true)
  })

  it('Custom override grants update via globals scope', () => {
    expect(
      assertScopeAllows(
        { globals: { siteSettings: ['read', 'update'] } },
        'updateGlobal',
        'siteSettings',
      ).allowed,
    ).toBe(true)
  })

  it('Custom narrow denies update when only read is granted', () => {
    const decision = assertScopeAllows(
      { globals: { siteSettings: ['read'] } },
      'updateGlobal',
      'siteSettings',
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/Action "update" on global "siteSettings"/)
  })

  it('globals-only key denies a collection tool', () => {
    const decision = assertScopeAllows(
      { globals: { siteSettings: ['read', 'update'] } },
      'findDocument',
      'pages',
    )
    expect(decision.allowed).toBe(false)
  })

  it('read-only preset denies updateGlobal', () => {
    const decision = assertScopeAllows({ preset: 'read-only' }, 'updateGlobal', 'siteSettings')
    expect(decision.allowed).toBe(false)
  })

  it('globals whitelist: unlisted slug is denied', () => {
    const decision = assertScopeAllows(
      { globals: { siteSettings: ['read', 'update'] } },
      'updateGlobal',
      'footer',
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/Global "footer" is not in this API key's allowed globals/)
  })
})

// ─── Fail-closed extensions for tools.allow without resource scope ───

describe('assertScopeAllows — tools.allow-only fail-closed', () => {
  it('denies updateGlobal when only tools.allow is set (no globals map, no preset)', () => {
    const decision = assertScopeAllows(
      { tools: { allow: ['updateGlobal'] } },
      'updateGlobal',
      'siteSettings',
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/explicit global scope or preset/)
  })

  it('denies updateDocument when only tools.allow is set (no collections map, no preset)', () => {
    const decision = assertScopeAllows(
      { tools: { allow: ['updateDocument'] } },
      'updateDocument',
      'pages',
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/explicit collection scope or preset/)
  })

  it('post-empty-Custom sentinel denies every dispatch path including globals', () => {
    const denyAll = { collections: {}, globals: {}, tools: { allow: [] } }
    expect(assertScopeAllows(denyAll, 'findGlobal', 'siteSettings').allowed).toBe(false)
    expect(assertScopeAllows(denyAll, 'updateGlobal', 'siteSettings').allowed).toBe(false)
    expect(assertScopeAllows(denyAll, 'findDocument', 'pages').allowed).toBe(false)
    expect(assertScopeAllows(denyAll, 'searchContent', undefined).allowed).toBe(false)
  })
})

// ─── Account-level routing ──────────────────────────────────────────

describe('assertScopeAllows — account-level tools', () => {
  it('searchContent allowed under read-only preset', () => {
    expect(
      assertScopeAllows({ preset: 'read-only' }, 'searchContent', undefined).allowed,
    ).toBe(true)
  })

  it('uploadMedia denied under read-only preset (requires create)', () => {
    expect(
      assertScopeAllows({ preset: 'read-only' }, 'uploadMedia', undefined).allowed,
    ).toBe(false)
  })

  it('unregistered tool name is denied with the registry-mapping reason', () => {
    const decision = assertScopeAllows({ preset: 'admin' }, 'whatIsThisTool', undefined)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/no registered scope mapping/)
  })
})

// ─── Registry invariant (boot-time guard) ────────────────────────────

describe('assertScopeRegistryInvariant', () => {
  it('passes for the production tool list (every registered tool is mapped)', () => {
    const all = [
      ...Object.keys(TOOL_TO_ACTION),
      ...Object.keys(TOOL_TO_GLOBAL_ACTION),
      ...ACCOUNT_LEVEL_TOOLS,
    ]
    expect(() => assertScopeRegistryInvariant(all)).not.toThrow()
  })

  it('throws with an actionable message when a tool is missing', () => {
    expect(() =>
      assertScopeRegistryInvariant(['findDocument', 'somethingNew']),
    ).toThrow(/somethingNew/)
  })

  it('routing maps stay disjoint in production: a name is never in two sets', () => {
    const collectionsAndGlobals = Object.keys(TOOL_TO_ACTION).filter(
      (n) => n in TOOL_TO_GLOBAL_ACTION,
    )
    expect(collectionsAndGlobals).toEqual([])
    const collectionsAndAccount = Object.keys(TOOL_TO_ACTION).filter((n) =>
      ACCOUNT_LEVEL_TOOLS.has(n),
    )
    expect(collectionsAndAccount).toEqual([])
    const globalsAndAccount = Object.keys(TOOL_TO_GLOBAL_ACTION).filter((n) =>
      ACCOUNT_LEVEL_TOOLS.has(n),
    )
    expect(globalsAndAccount).toEqual([])
  })
})

describe('resolveResourceKind', () => {
  it('returns the expected kind for known tools', () => {
    expect(resolveResourceKind('findDocument')).toBe('collection')
    expect(resolveResourceKind('findGlobal')).toBe('global')
    expect(resolveResourceKind('searchContent')).toBe('account')
    expect(resolveResourceKind('not-a-tool')).toBeNull()
  })
})

// ─── Initializer integration ─────────────────────────────────────────

interface MockServer {
  registerTool: ReturnType<typeof vi.fn>
  registerPrompt: ReturnType<typeof vi.fn>
  registerResource: ReturnType<typeof vi.fn>
}

function buildMockServer(): MockServer {
  return {
    registerTool: vi.fn(),
    registerPrompt: vi.fn(),
    registerResource: vi.fn(),
  }
}

function buildReq(opts: {
  scopes?: Parameters<typeof assertScopeAllows>[0]
  keyId?: string
  keyPrefix?: string
  requestId?: string
} = {}) {
  const headers = new Headers()
  if (opts.requestId) headers.set('x-request-id', opts.requestId)
  return {
    headers,
    context: {},
    payload: {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    user: {
      _mcpKey: {
        keyId: opts.keyId ?? 'k1',
        keyPrefix: opts.keyPrefix ?? 'abc12345',
        scopes: opts.scopes ?? null,
      },
    },
  }
}

function makeTool(handler: ToolFactoryOutput['handler']): ToolFactoryOutput {
  return {
    name: 'createDocument',
    description: 'create a document',
    parameters: { collection: z.string(), data: z.string() },
    handler,
  }
}

describe('createInitializeServer', () => {
  let server: MockServer

  beforeEach(() => {
    server = buildMockServer()
  })

  it('registers each tool exactly once on the McpServer', () => {
    const toolHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const init = createInitializeServer({ tools: [makeTool(toolHandler)] })
    init(buildReq() as never)(server as never)
    expect(server.registerTool).toHaveBeenCalledTimes(1)
    expect(server.registerTool.mock.calls[0]![0]).toBe('createDocument')
  })

  it('wraps the handler so a happy call invokes the tool and logs success', async () => {
    const toolHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const req = buildReq()
    const init = createInitializeServer({ tools: [makeTool(toolHandler)] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    const result = await wrapped({ collection: 'posts', data: '{"title":"hi"}' }, { ok: 1 })
    expect(toolHandler).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(req.payload.logger.info).toHaveBeenCalled()
  })

  it('rejects with isError result when scopes deny the call (no JSON-RPC error)', async () => {
    const toolHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const req = buildReq({ scopes: { preset: 'read-only' } })
    const init = createInitializeServer({ tools: [makeTool(toolHandler)] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    const result = (await wrapped({ collection: 'posts', data: '{}' }, {})) as {
      isError: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/scope/i)
    expect(toolHandler).not.toHaveBeenCalled()
    expect(req.payload.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'ScopeRejection', success: false }),
      expect.any(String),
    )
  })

  it('catches handler errors and returns isError result without throwing', async () => {
    const toolHandler = vi.fn(async () => {
      throw new Error('payload exploded')
    })
    const req = buildReq()
    const init = createInitializeServer({ tools: [makeTool(toolHandler)] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    const result = (await wrapped({ collection: 'posts', data: '{}' }, {})) as {
      isError: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/payload exploded/)
    expect(req.payload.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'Error' }),
      expect.any(String),
    )
  })

  it('logs the parsed top-level data keys (not values)', async () => {
    const toolHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const req = buildReq()
    const init = createInitializeServer({ tools: [makeTool(toolHandler)] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    await wrapped(
      { collection: 'posts', data: '{"title":"hi","slug":"hi","secretField":"sensitive"}' },
      {},
    )

    const [logFields] = req.payload.logger.info.mock.calls[0]!
    expect(logFields.dataKeys).toEqual(['title', 'slug', 'secretField'])
    // Values must NOT be in the log, only key names
    expect(JSON.stringify(logFields)).not.toContain('sensitive')
  })

  it('truncates long string args in the error log summary', async () => {
    const toolHandler = vi.fn(async () => {
      throw new Error('boom')
    })
    const req = buildReq()
    const init = createInitializeServer({ tools: [makeTool(toolHandler)] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    const big = 'x'.repeat(5000)
    await wrapped({ collection: 'posts', data: big }, {})
    const [logFields] = req.payload.logger.error.mock.calls[0]!
    expect(logFields.argsSummary.data).toBe('<truncated:5000>')
  })

  it('normalizes z.object() params to a raw shape before registering with the SDK', () => {
    const tool = {
      name: 'resolveReference',
      description: 'x',
      parameters: z.object({ query: z.string(), collection: z.string().optional() }),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    }
    const init = createInitializeServer({ tools: [tool] })
    init(buildReq() as never)(server as never)
    const inputSchema = server.registerTool.mock.calls[0]![1]!.inputSchema as Record<
      string,
      unknown
    >
    expect(Object.keys(inputSchema).sort()).toEqual(['collection', 'query'])
  })

  it('audit log carries targetSlug + targetKind for a collection tool', async () => {
    const toolHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const req = buildReq()
    const tool: ToolFactoryOutput = {
      name: 'findDocument',
      description: 'x',
      parameters: { collection: z.string() },
      handler: toolHandler,
    }
    const init = createInitializeServer({ tools: [tool] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    await wrapped({ collection: 'pages' }, {})
    const [logFields] = req.payload.logger.info.mock.calls[0]!
    expect(logFields.targetSlug).toBe('pages')
    expect(logFields.targetKind).toBe('collection')
    expect((logFields as Record<string, unknown>).collectionArg).toBeUndefined()
  })

  it('audit log carries targetSlug + targetKind for a global tool', async () => {
    const toolHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const req = buildReq()
    const tool: ToolFactoryOutput = {
      name: 'findGlobal',
      description: 'x',
      parameters: { slug: z.string() },
      handler: toolHandler,
    }
    const init = createInitializeServer({ tools: [tool] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    await wrapped({ slug: 'siteSettings' }, {})
    const [logFields] = req.payload.logger.info.mock.calls[0]!
    expect(logFields.targetSlug).toBe('siteSettings')
    expect(logFields.targetKind).toBe('global')
  })

  it('audit log marks account-level tools with targetKind="account" and no targetSlug', async () => {
    const toolHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const req = buildReq()
    const tool: ToolFactoryOutput = {
      name: 'searchContent',
      description: 'x',
      parameters: { q: z.string() },
      handler: toolHandler,
    }
    const init = createInitializeServer({ tools: [tool] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>

    await wrapped({ q: 'hello' }, {})
    const [logFields] = req.payload.logger.info.mock.calls[0]!
    expect(logFields.targetSlug).toBeUndefined()
    expect(logFields.targetKind).toBe('account')
  })

  it('stamps mcp context on req before invoking the handler', async () => {
    const toolHandler = vi.fn(async (_args, req: Record<string, { source?: string }>) => {
      expect(req.context!.source).toBe('mcp')
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    const req = buildReq()
    const init = createInitializeServer({ tools: [makeTool(toolHandler)] })
    init(req as never)(server as never)
    const wrapped = server.registerTool.mock.calls[0]![2] as (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>
    await wrapped({ collection: 'posts', data: '{}' }, {})
    expect(toolHandler).toHaveBeenCalled()
  })
})
