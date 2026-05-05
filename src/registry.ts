import type { PayloadRequest } from 'payload'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z, type ZodTypeAny } from 'zod'
import {
  getApiKeyContext,
  type CollectionAction,
  type KeyScopes,
  type ScopePreset,
} from './auth-strategy'
import type { InitializeServerForRequest } from './endpoint'
import { stampMcpContext, type McpTextResponse } from './tools/_helpers'

// ─── Tool / Prompt / Resource shapes ──────────────────────────────────

export interface ToolFactoryOutput {
  name: string
  description: string
  parameters: Record<string, ZodTypeAny>
  handler: (
    args: Record<string, unknown>,
    req: PayloadRequest,
    extra: unknown,
  ) => Promise<McpTextResponse> | McpTextResponse
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

// ─── Scope evaluation ────────────────────────────────────────────────

const ALL_ACTIONS: CollectionAction[] = ['read', 'create', 'update', 'delete']

const PRESET_ACTIONS: Record<ScopePreset, CollectionAction[]> = {
  'read-only': ['read'],
  editor: ['read', 'create', 'update'],
  admin: ALL_ACTIONS,
}

const PRESET_TOOL_DENY: Record<ScopePreset, string[]> = {
  'read-only': [],
  editor: ['safeDelete', 'deleteDocument'],
  admin: [],
}

const TOOL_TO_ACTION: Record<string, CollectionAction> = {
  findDocument: 'read',
  searchContent: 'read',
  resolveReference: 'read',
  listVersions: 'read',
  createDocument: 'create',
  uploadMedia: 'create',
  updateDocument: 'update',
  patchLayout: 'update',
  publishDraft: 'update',
  schedulePublish: 'update',
  restoreVersion: 'update',
  deleteDocument: 'delete',
  safeDelete: 'delete',
}

export interface ScopeDecision {
  allowed: boolean
  reason?: string
}

/**
 * Pure function: given the request's scopes and the tool/collection in play,
 * decide whether the tool call is permitted. Null/undefined scopes grant
 * full access (back-compat for keys that pre-date scoped authz).
 */
export function assertScopeAllows(
  scopes: KeyScopes | null | undefined,
  toolName: string,
  collection: string | undefined,
): ScopeDecision {
  if (!scopes || (scopes.preset === undefined && !scopes.collections && !scopes.tools)) {
    return { allowed: true }
  }

  if (scopes.tools?.deny?.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is denied for this API key.` }
  }
  if (scopes.tools?.allow && !scopes.tools.allow.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the allow-list for this API key.`,
    }
  }

  if (scopes.preset && PRESET_TOOL_DENY[scopes.preset]?.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not allowed by the "${scopes.preset}" preset.`,
    }
  }

  if (collection) {
    const action = TOOL_TO_ACTION[toolName]
    if (!action) return { allowed: true }
    const override = scopes.collections?.[collection]
    const presetActions = scopes.preset ? PRESET_ACTIONS[scopes.preset] : undefined
    const effective = override ?? presetActions
    if (effective && !effective.includes(action)) {
      return {
        allowed: false,
        reason: `Action "${action}" on collection "${collection}" is not permitted by this API key's scope.`,
      }
    }
  }

  return { allowed: true }
}

// ─── Audit logging helpers ───────────────────────────────────────────

const MAX_LOGGED_STRING = 200

/**
 * Returns the top-level keys of a JSON-string `data` arg, sanitized.
 * Per the Codex post-planning finding: logging key names (not values) lets us
 * later analyze whether the prose-only input shape is causing AI mistakes.
 */
function extractDataKeys(args: Record<string, unknown>): string[] | undefined {
  const data = args.data
  if (typeof data !== 'string') return undefined
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>)
    }
  } catch {
    return undefined
  }
  return undefined
}

function summariseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > MAX_LOGGED_STRING) {
      out[k] = `<truncated:${v.length}>`
    } else {
      out[k] = v
    }
  }
  return out
}

function getRequestId(req: PayloadRequest): string | undefined {
  const headers = req.headers as Headers | undefined
  return headers?.get?.('x-request-id') ?? undefined
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

  return (req: PayloadRequest) => (server: McpServer) => {
    const logger = req.payload?.logger
    const requestId = getRequestId(req)

    for (const tool of tools) {
      const wrapped = async (
        args: Record<string, unknown>,
        extra: unknown,
      ): Promise<unknown> => {
        const start = Date.now()
        const keyCtx = getApiKeyContext(req)
        const collectionArg = typeof args.collection === 'string' ? args.collection : undefined
        const dataKeys = extractDataKeys(args)

        const decision = assertScopeAllows(keyCtx?.scopes ?? null, tool.name, collectionArg)
        if (!decision.allowed) {
          logger?.warn?.(
            {
              event: 'mcp.tool_call',
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              collectionArg,
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
          logger?.info?.(
            {
              event: 'mcp.tool_call',
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              collectionArg,
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
          logger?.error?.(
            {
              event: 'mcp.tool_call',
              err,
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              collectionArg,
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

      // Cast: SDK's inputSchema accepts a ZodRawShape; our parameters use the
      // same shape under a different field name.
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.parameters as Record<string, ZodTypeAny>,
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
