import type { Endpoint, PayloadRequest } from 'payload'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpHandler } from 'mcp-handler'
import { getApiKeyContext } from './auth-strategy'

export const MCP_BASE_PATH = '/api/mcp'
export const MCP_ENDPOINT_PATH = '/mcp'
/**
 * `mcp-handler` derives its streamable-HTTP route as `${basePath}/mcp`. To
 * land that on `/api/mcp` (the public URL), we pass `/api` here — not the
 * full `/api/mcp`, which would route to `/api/mcp/mcp` and 404.
 */
const MCP_HANDLER_BASE_PATH = '/api'

export type InitializeServerForRequest = (
  req: PayloadRequest,
) => (server: McpServer) => void | Promise<void>

export interface CreateMcpEndpointsOptions {
  /**
   * Per-request factory that returns the McpServer initializer. Called once
   * per POST /api/mcp; the returned callback receives a fresh McpServer
   * instance and registers tools/prompts/resources scoped to this request.
   */
  buildInitializeServer: InitializeServerForRequest
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
  const { buildInitializeServer, allowedOrigins, serverURL, verboseLogs = false } = options

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

    // Auth gate. The bearer strategy populates req.user._mcpKey on a valid
    // Authorization: Bearer <key>; missing context means the request did not
    // present a recognized MCP API key. We refuse before constructing any
    // mcp-handler — refusing here prevents tools/list and tool dispatch from
    // running on unauthenticated requests.
    if (!getApiKeyContext(req)) {
      return jsonRpcError('Unauthorized: MCP API key required', -32001, 401)
    }

    if (!req.url) return jsonRpcError('Missing request URL', -32600, 400)

    const handler = createMcpHandler(buildInitializeServer(req), undefined, {
      basePath: MCP_HANDLER_BASE_PATH,
      disableSse: true,
      verboseLogs,
    })

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
