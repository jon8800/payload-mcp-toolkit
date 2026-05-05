import type { Endpoint, PayloadRequest } from 'payload'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpHandler } from 'mcp-handler'

export const MCP_BASE_PATH = '/api/mcp'
export const MCP_ENDPOINT_PATH = '/mcp'

export interface CreateMcpEndpointsOptions {
  /** Callback that registers tools/prompts/resources on a fresh McpServer per request. */
  initializeServer: (server: McpServer) => void | Promise<void>
  /**
   * Origins permitted to send the `Origin` header. Server-to-server callers
   * (no Origin) are always allowed. An empty / unset list means "no browsers".
   * `*` is intentionally not honoured — be explicit.
   */
  allowedOrigins?: string[]
  /**
   * The Payload `serverURL`. When set, the request `Host` header must match
   * this origin's host (DNS-rebinding mitigation). When unset, host check is
   * skipped (useful in dev where the host varies).
   */
  serverURL?: string
  /** Forwarded to mcp-handler. Default false. */
  verboseLogs?: boolean
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0'
  error: { code: number; message: string }
  id: null
}

function jsonRpcError(message: string, code: number, status: number): Response {
  const body: JsonRpcErrorBody = { jsonrpc: '2.0', id: null, error: { code, message } }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function isOriginAllowed(origin: string | null, allowedOrigins: string[] | undefined): boolean {
  if (!origin) return true // server-to-server
  if (!allowedOrigins || allowedOrigins.length === 0) return false
  return allowedOrigins.includes(origin)
}

function isHostAllowed(host: string | null, serverURL: string | undefined): boolean {
  if (!serverURL) return true // dev / no serverURL configured
  if (!host) return false
  let expected: string
  try {
    expected = new URL(serverURL).host
  } catch {
    return true // misconfigured serverURL — fail open rather than break boot
  }
  return host === expected
}

/**
 * Builds the POST + GET endpoints for `/api/mcp`. Designed to be pushed into
 * `incomingConfig.endpoints` (additive — existing endpoints are preserved).
 *
 * Pure function; can be unit-tested by invoking the returned handlers with a
 * minimally-shaped PayloadRequest.
 */
export function createMcpEndpoints(options: CreateMcpEndpointsOptions): Endpoint[] {
  const { initializeServer, allowedOrigins, serverURL, verboseLogs = false } = options

  const handler = createMcpHandler(initializeServer, undefined, {
    basePath: MCP_BASE_PATH,
    disableSse: true,
    verboseLogs,
  })

  const postHandler = async (req: PayloadRequest): Promise<Response> => {
    const headers = req.headers as Headers | undefined
    const origin = headers?.get('origin') ?? null
    const host = headers?.get('host') ?? null

    if (!isHostAllowed(host, serverURL)) {
      return jsonRpcError('Invalid host', -32600, 400)
    }
    if (!isOriginAllowed(origin, allowedOrigins)) {
      return jsonRpcError('Origin not allowed', -32600, 403)
    }

    if (!req.url) return jsonRpcError('Missing request URL', -32600, 400)

    const fetchRequest = new Request(req.url, {
      method: req.method ?? 'POST',
      headers: req.headers as HeadersInit,
      body: req.body as BodyInit | null | undefined,
      // duplex is required for streaming bodies in newer node fetch
      ...({ duplex: 'half' } as Record<string, unknown>),
    })

    return handler(fetchRequest)
  }

  const getHandler = async (): Promise<Response> => {
    return jsonRpcError('POST required for MCP requests', -32600, 405)
  }

  return [
    { path: MCP_ENDPOINT_PATH, method: 'post', handler: postHandler },
    { path: MCP_ENDPOINT_PATH, method: 'get', handler: getHandler },
  ]
}
