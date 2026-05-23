import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlerMock = vi.fn(async () => new Response('"ok"', { status: 200 }))
const createMcpHandlerMock = vi.fn(() => handlerMock)

vi.mock('mcp-handler', () => ({
  createMcpHandler: (...args: unknown[]) => createMcpHandlerMock(...args),
}))

import { createMcpEndpoints, MCP_ENDPOINT_PATH } from '../endpoint'

function buildReq(overrides: {
  origin?: string | null
  host?: string | null
  method?: string
  body?: unknown
  authenticated?: boolean
}) {
  const headers = new Headers()
  if (overrides.origin) headers.set('origin', overrides.origin)
  if (overrides.host) headers.set('host', overrides.host)
  const authenticated = overrides.authenticated !== false
  return {
    url: 'https://app.example.com/api/mcp',
    method: overrides.method ?? 'POST',
    headers,
    body: overrides.body ?? null,
    user: authenticated
      ? {
          _mcpKey: { keyId: 'k1', keyPrefix: 'abc12345', scopes: null },
        }
      : null,
  }
}

beforeEach(() => {
  handlerMock.mockClear()
  createMcpHandlerMock.mockClear()
})

describe('createMcpEndpoints', () => {
  const initializeServer = vi.fn()
  const buildInitializeServer = vi.fn(() => initializeServer)

  beforeEach(() => {
    initializeServer.mockClear()
    buildInitializeServer.mockClear()
  })

  it('registers POST + GET endpoints at /mcp', () => {
    const endpoints = createMcpEndpoints({ buildInitializeServer })
    expect(endpoints).toHaveLength(2)
    const methods = endpoints.map((e) => e.method).sort()
    expect(methods).toEqual(['get', 'post'])
    for (const e of endpoints) expect(e.path).toBe(MCP_ENDPOINT_PATH)
  })

  it('GET returns 405 with a JSON-RPC error body', async () => {
    const [, getEndpoint] = createMcpEndpoints({ buildInitializeServer })
    const res = await getEndpoint.handler(buildReq({ method: 'GET' }) as never)
    expect(res.status).toBe(405)
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } }
    expect(body.jsonrpc).toBe('2.0')
    expect(body.error.message).toMatch(/POST/i)
  })

  it('POST with valid host + no origin delegates to mcp-handler', async () => {
    const [postEndpoint] = createMcpEndpoints({
      buildInitializeServer,
      serverURL: 'https://app.example.com',
    })
    const res = await postEndpoint.handler(
      buildReq({ host: 'app.example.com' }) as never,
    )
    expect(res.status).toBe(200)
    expect(handlerMock).toHaveBeenCalledTimes(1)
  })

  it('rejects POST with mismatched Host header (DNS rebinding mitigation)', async () => {
    const [postEndpoint] = createMcpEndpoints({
      buildInitializeServer,
      serverURL: 'https://app.example.com',
    })
    const res = await postEndpoint.handler(
      buildReq({ host: 'evil.example.com' }) as never,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/host/i)
    expect(handlerMock).not.toHaveBeenCalled()
  })

  it('skips host validation when serverURL is not configured', async () => {
    const [postEndpoint] = createMcpEndpoints({ buildInitializeServer })
    const res = await postEndpoint.handler(
      buildReq({ host: 'whatever.example.com' }) as never,
    )
    expect(res.status).toBe(200)
  })

  it('rejects POST with disallowed Origin', async () => {
    const [postEndpoint] = createMcpEndpoints({
      buildInitializeServer,
      allowedOrigins: ['https://app.example.com'],
    })
    const res = await postEndpoint.handler(
      buildReq({ origin: 'https://attacker.example.com' }) as never,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/origin/i)
    expect(handlerMock).not.toHaveBeenCalled()
  })

  it('allows server-to-server POST (no Origin header) even when allowedOrigins is empty', async () => {
    const [postEndpoint] = createMcpEndpoints({ buildInitializeServer })
    const res = await postEndpoint.handler(buildReq({}) as never)
    expect(res.status).toBe(200)
  })

  it('forwards a constructed Fetch Request to the mcp-handler', async () => {
    const [postEndpoint] = createMcpEndpoints({ buildInitializeServer })
    await postEndpoint.handler(buildReq({}) as never)
    const [forwarded] = handlerMock.mock.calls[0]!
    expect(forwarded).toBeInstanceOf(Request)
    expect((forwarded as Request).method).toBe('POST')
  })

  it('rejects unauthenticated POSTs with 401 before constructing the mcp-handler', async () => {
    const [postEndpoint] = createMcpEndpoints({ buildInitializeServer })
    const res = await postEndpoint.handler(buildReq({ authenticated: false }) as never)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/MCP API key required/)
    expect(handlerMock).not.toHaveBeenCalled()
    expect(buildInitializeServer).not.toHaveBeenCalled()
  })
})
