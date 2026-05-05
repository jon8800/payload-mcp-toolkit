import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  assertScopeAllows,
  createInitializeServer,
  type ToolFactoryOutput,
} from '../registry'

describe('assertScopeAllows', () => {
  it('grants full access when scopes is null/undefined or empty', () => {
    expect(assertScopeAllows(null, 'createDocument', 'posts').allowed).toBe(true)
    expect(assertScopeAllows(undefined, 'deleteDocument', 'posts').allowed).toBe(true)
    expect(assertScopeAllows({}, 'createDocument', 'posts').allowed).toBe(true)
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
