import type { PayloadRequest } from 'payload'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z, ZodObject, type ZodTypeAny } from 'zod'
import { getApiKeyContext } from './auth-strategy'
import type { InitializeServerForRequest } from './endpoint'
import { stampMcpContext, type McpTextResponse } from './tools/_helpers'
import {
  assertScopeAllows,
  buildRoutingTables,
  buildScopeChecker,
  type ResourceKind,
  type RoutingTables,
  type ScopeChecker,
  type ScopeDecision,
  type ToolRouting,
} from './scope/policy'
import { extractDataKeys, getRequestId, makeSafeLog, summariseArgs } from './scope/audit-log'

// ─── Tool / Prompt / Resource shapes ──────────────────────────────────

export interface ToolFactoryOutput {
  name: string
  description: string
  /**
   * Either a raw Zod shape (`{ key: ZodType }`) or a `z.object({...})`
   * instance. The registry normalises both before registering with the SDK.
   */
  parameters: Record<string, ZodTypeAny> | ZodObject<Record<string, ZodTypeAny>>
  handler: (
    args: Record<string, unknown>,
    req: PayloadRequest,
    extra: unknown,
  ) => Promise<McpTextResponse> | McpTextResponse
  routing: ToolRouting
}

/**
 * Returns the raw `{ name: ZodType }` shape for either a raw shape or a
 * `z.object({...})` instance. The MCP SDK's `registerTool` expects the raw
 * shape under `inputSchema`; passing a ZodObject silently registers an
 * empty schema and breaks args validation.
 */
function toZodShape(
  parameters: Record<string, ZodTypeAny> | ZodObject<Record<string, ZodTypeAny>>,
): Record<string, ZodTypeAny> {
  if (parameters instanceof ZodObject) {
    return parameters.shape as Record<string, ZodTypeAny>
  }
  return parameters
}

export interface PromptFactoryOutput {
  name: string
  title?: string
  description?: string
  argsSchema?: Record<string, ZodTypeAny>
  handler: (args: unknown, req: PayloadRequest, extra: unknown) => unknown
}

export interface ResourceFactoryOutput {
  name: string
  uri: string
  title?: string
  description?: string
  mimeType?: string
  handler: (args: unknown, req: PayloadRequest, extra: unknown) => unknown
}

// Re-export scope-routing primitives so existing callers keep working.
export {
  buildScopeChecker,
  type ResourceKind,
  type RoutingTables,
  type ScopeChecker,
  type ScopeDecision,
  type ToolRouting,
}

// ─── Initializer factory ─────────────────────────────────────────────

export interface CreateInitializeServerOptions {
  tools: ToolFactoryOutput[]
  prompts?: PromptFactoryOutput[]
  resources?: ResourceFactoryOutput[]
}

interface ScopeRejectionResult {
  content: Array<{ type: 'text'; text: string }>
  isError: true
}

function scopeRejectionResult(reason: string): ScopeRejectionResult {
  return {
    content: [{ type: 'text', text: `Scope rejection: ${reason}` }],
    isError: true,
  }
}

/**
 * Builds the per-request initializer. mcp-handler invokes this once per
 * `tools/call` / `tools/list` JSON-RPC request, passing a fresh McpServer.
 *
 * Each tool handler is wrapped to:
 *   1. Read the API-key context populated by the bearer auth strategy.
 *   2. Reject the call (as an `isError: true` result, not a JSON-RPC error)
 *      when scopes deny it — per the MCP spec, tool-execution failures
 *      surface in the result envelope so the LLM can self-correct.
 *   3. Stamp `req.context.source = 'mcp'` for downstream hooks.
 *   4. Emit a structured audit log entry on every success / failure.
 */
export function createInitializeServer(
  options: CreateInitializeServerOptions,
): InitializeServerForRequest {
  const { tools, prompts = [], resources = [] } = options
  const tables: RoutingTables = buildRoutingTables(tools)

  return (req: PayloadRequest) => (server: McpServer) => {
    const logger = req.payload?.logger
    const requestId = getRequestId(req)
    const safeLog = makeSafeLog(logger)

    for (const tool of tools) {
      const resourceKind = tables.toolKind.get(tool.name) ?? null
      const wrapped = async (
        args: Record<string, unknown>,
        extra: unknown,
      ): Promise<unknown> => {
        const start = Date.now()
        const keyCtx = getApiKeyContext(req)
        const targetSlug =
          typeof args.collection === 'string'
            ? args.collection
            : typeof args.slug === 'string'
              ? args.slug
              : undefined
        const targetKind = resourceKind ?? undefined
        const dataKeys = extractDataKeys(args)

        const decision = assertScopeAllows(
          keyCtx?.scopes ?? null,
          tool.name,
          targetSlug,
          tables,
        )

        if (!decision.allowed) {
          safeLog(
            'warn',
            {
              event: 'mcp.tool_call',
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              targetSlug,
              targetKind,
              dataKeys,
              success: false,
              isError: true,
              durationMs: Date.now() - start,
              requestId,
              errorClass: 'ScopeRejection',
            },
            `[payload-mcp-toolkit] Scope-rejected tool call: ${tool.name}`,
          )
          return scopeRejectionResult(decision.reason ?? 'denied')
        }

        stampMcpContext(req)

        try {
          const result = await tool.handler(args, req, extra)
          safeLog(
            'info',
            {
              event: 'mcp.tool_call',
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              targetSlug,
              targetKind,
              dataKeys,
              success: true,
              isError: false,
              durationMs: Date.now() - start,
              requestId,
            },
            `[payload-mcp-toolkit] Tool call: ${tool.name}`,
          )
          return result
        } catch (err) {
          const errorClass = err instanceof Error ? err.name : 'UnknownError'
          const message = err instanceof Error ? err.message : String(err)
          safeLog(
            'error',
            {
              event: 'mcp.tool_call',
              err,
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              targetSlug,
              targetKind,
              dataKeys,
              argsSummary: summariseArgs(args),
              success: false,
              isError: true,
              durationMs: Date.now() - start,
              requestId,
              errorClass,
            },
            `[payload-mcp-toolkit] Tool call failed: ${tool.name}`,
          )
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
          }
        }
      }

      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: toZodShape(tool.parameters),
        },
        wrapped as never,
      )
    }

    for (const prompt of prompts) {
      const wrapped = async (args: unknown, extra: unknown) => {
        try {
          return await prompt.handler(args, req, extra)
        } catch (err) {
          logger?.error?.(
            { event: 'mcp.prompt', err, prompt: prompt.name, requestId },
            `[payload-mcp-toolkit] Prompt failed: ${prompt.name}`,
          )
          throw err
        }
      }
      server.registerPrompt(
        prompt.name,
        {
          title: prompt.title,
          description: prompt.description,
          argsSchema: prompt.argsSchema as never,
        },
        wrapped as never,
      )
    }

    for (const resource of resources) {
      const wrapped = async (args: unknown, extra: unknown) => {
        try {
          return await resource.handler(args, req, extra)
        } catch (err) {
          logger?.error?.(
            { event: 'mcp.resource', err, resource: resource.name, requestId },
            `[payload-mcp-toolkit] Resource read failed: ${resource.name}`,
          )
          throw err
        }
      }
      server.registerResource(
        resource.name,
        resource.uri as never,
        {
          title: resource.title,
          description: resource.description,
          mimeType: resource.mimeType,
        },
        wrapped as never,
      )
    }
  }
}

// Helper retained for symmetry / explicit imports. Acts as a sanity check
// that downstream callers see a consistent z reference.
export const zodRefForDeps: typeof z = z
